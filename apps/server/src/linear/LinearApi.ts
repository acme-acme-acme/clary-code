import type {
  LinearIssueActivity,
  LinearIssueDetail,
  LinearIssueDetailPerson,
  LinearIssueState,
  LinearIssueStateType,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
/** Aliased lookups per request; Linear caps a single query's complexity. */
const MAX_ISSUES_PER_REQUEST = 50;

export class LinearApiError extends Schema.TaggedError<LinearApiError>()("LinearApiError", {
  detail: Schema.String,
}) {}

/** The team's started states, to place an issue's state among them. */
const StartedStates = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ position: Schema.Number })),
});

const IssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
  state: Schema.Struct({
    name: Schema.String,
    type: Schema.String,
    color: Schema.String,
    position: Schema.optional(Schema.Number),
  }),
  assignee: Schema.NullOr(Schema.Struct({ displayName: Schema.String })),
  team: Schema.optional(Schema.Struct({ states: StartedStates })),
});

const IssuesResponse = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(IssueNode)))),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});
const decodeIssuesResponse = Schema.decodeUnknownEffect(IssuesResponse);

export interface LinearIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly updatedAt: string | null;
  readonly state: LinearIssueState;
  readonly assignee: string | null;
}

const KNOWN_STATE_TYPES = new Set<string>([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);

const ISSUE_FIELDS = `id identifier title url updatedAt state { name type color position }
  assignee { displayName } team { states(filter: { type: { eq: "started" } }) { nodes { position } } }`;

/**
 * The issue's state, with how far along a started state is among the team's
 * started states: Linear fills its state icon's pie by that much.
 */
function toLinearIssueState(
  state: {
    readonly name: string;
    readonly type: string;
    readonly color: string;
    readonly position?: number | undefined;
  },
  startedPositions: ReadonlyArray<{ readonly position: number }> | undefined,
): LinearIssueState {
  const type = (KNOWN_STATE_TYPES.has(state.type) ? state.type : "unknown") as LinearIssueStateType;
  const positions = (startedPositions ?? [])
    .map((entry) => entry.position)
    .toSorted((a, b) => a - b);
  const index = state.position === undefined ? -1 : positions.indexOf(state.position);
  return {
    name: state.name,
    type,
    color: state.color,
    ...(type === "started" && index >= 0 ? { progress: (index + 1) / (positions.length + 1) } : {}),
  };
}

const Person = Schema.NullOr(
  Schema.Struct({
    displayName: Schema.String,
    avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const Bot = Schema.NullOr(Schema.Struct({ name: Schema.NullOr(Schema.String) }));
const StateChip = Schema.NullOr(
  Schema.Struct({
    name: Schema.String,
    color: Schema.String,
    type: Schema.String,
    position: Schema.optional(Schema.Number),
  }),
);
const Named = Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String })));

const IssueDetailNode = Schema.Struct({
  ...IssueNode.fields,
  description: Schema.NullOr(Schema.String),
  priority: Schema.Number,
  priorityLabel: Schema.String,
  createdAt: Schema.String,
  branchName: Schema.String,
  assignee: Person,
  creator: Person,
  team: Schema.Struct({ key: Schema.String, name: Schema.String, states: StartedStates }),
  project: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  labels: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.String })),
  }),
  attachments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        title: Schema.String,
        subtitle: Schema.NullOr(Schema.String),
        url: Schema.String,
        sourceType: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  comments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        body: Schema.String,
        createdAt: Schema.String,
        parent: Schema.NullOr(Schema.Struct({ id: Schema.String })),
        user: Person,
        botActor: Bot,
        externalUser: Schema.NullOr(
          Schema.Struct({ name: Schema.String, avatarUrl: Schema.NullOr(Schema.String) }),
        ),
        externalThread: Schema.NullOr(
          Schema.Struct({
            name: Schema.NullOr(Schema.String),
            displayName: Schema.NullOr(Schema.String),
            url: Schema.NullOr(Schema.String),
          }),
        ),
        syncedWith: Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              service: Schema.String,
              metadata: Schema.NullOr(
                Schema.Struct({ isFromSlack: Schema.optional(Schema.Boolean) }),
              ),
            }),
          ),
        ),
      }),
    ),
  }),
  history: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        createdAt: Schema.String,
        actor: Person,
        botActor: Bot,
        fromState: StateChip,
        toState: StateChip,
        fromAssignee: Person,
        toAssignee: Person,
        addedLabels: Named,
        removedLabels: Named,
        fromPriority: Schema.NullOr(Schema.Number),
        toPriority: Schema.NullOr(Schema.Number),
        fromTitle: Schema.NullOr(Schema.String),
        toTitle: Schema.NullOr(Schema.String),
        attachment: Schema.NullOr(Schema.Struct({ title: Schema.String, url: Schema.String })),
      }),
    ),
  }),
});
type IssueDetailNode = typeof IssueDetailNode.Type;

const IssueDetailResponse = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Struct({ issue: Schema.NullOr(IssueDetailNode) }))),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});
const decodeIssueDetailResponse = Schema.decodeUnknownEffect(IssueDetailResponse);

const PERSON_FIELDS = "displayName avatarUrl";
/** Linear's largest page; an issue with more shows its latest and says so. */
const ACTIVITY_PAGE_SIZE = 250;

/** The page's sections, with the most recent comments and changes. */
const ISSUE_DETAIL_QUERY = `query($id: String!) { issue(id: $id) {
  ${ISSUE_FIELDS} description priority priorityLabel createdAt branchName
  assignee { ${PERSON_FIELDS} } creator { ${PERSON_FIELDS} }
  team { key name } project { name } labels { nodes { name color } }
  attachments(first: 50) { nodes { title subtitle url sourceType } }
  comments(last: ${ACTIVITY_PAGE_SIZE}) { nodes { id body createdAt parent { id } user { ${PERSON_FIELDS} } botActor { name }
    externalUser { name avatarUrl } externalThread { name displayName url }
    syncedWith { service metadata { ... on ExternalEntitySlackMetadata { isFromSlack } } } } }
  history(last: ${ACTIVITY_PAGE_SIZE}) { nodes { id createdAt actor { ${PERSON_FIELDS} } botActor { name }
    fromState { name color type position } toState { name color type position } fromAssignee { ${PERSON_FIELDS} } toAssignee { ${PERSON_FIELDS} }
    addedLabels { name } removedLabels { name } fromPriority toPriority fromTitle toTitle attachment { title url } } }
} }`;

const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"];
const priorityLabel = (priority: number | null) =>
  priority === null ? null : (PRIORITY_LABELS[priority] ?? null);

function person(
  node: { readonly displayName: string; readonly avatarUrl?: string | null | undefined } | null,
): LinearIssueDetailPerson | null {
  const name = node?.displayName.trim();
  return name ? { name, avatarUrl: node?.avatarUrl ?? null } : null;
}

function actorOf(
  user: IssueDetailNode["comments"]["nodes"][number]["user"],
  bot: IssueDetailNode["comments"]["nodes"][number]["botActor"],
): LinearIssueDetailPerson | null {
  return person(user) ?? (bot?.name?.trim() ? { name: bot.name.trim(), avatarUrl: null } : null);
}

/** One history entry as the change it records; entries the page can't show are dropped. */
function historyActivity(
  entry: IssueDetailNode["history"]["nodes"][number],
  startedPositions: IssueDetailNode["team"]["states"]["nodes"],
): LinearIssueActivity | null {
  const base = {
    id: entry.id,
    createdAt: entry.createdAt,
    actor: actorOf(entry.actor, entry.botActor),
  };
  if (entry.fromState || entry.toState) {
    return {
      ...base,
      kind: "state",
      from: entry.fromState && toLinearIssueState(entry.fromState, startedPositions),
      to: entry.toState && toLinearIssueState(entry.toState, startedPositions),
    };
  }
  if (entry.fromAssignee || entry.toAssignee) {
    return {
      ...base,
      kind: "assignee",
      from: person(entry.fromAssignee)?.name ?? null,
      to: person(entry.toAssignee)?.name ?? null,
    };
  }
  if ((entry.addedLabels?.length ?? 0) > 0 || (entry.removedLabels?.length ?? 0) > 0) {
    return {
      ...base,
      kind: "labels",
      added: (entry.addedLabels ?? []).map((label) => label.name),
      removed: (entry.removedLabels ?? []).map((label) => label.name),
    };
  }
  if (entry.fromPriority !== null || entry.toPriority !== null) {
    return {
      ...base,
      kind: "priority",
      from: priorityLabel(entry.fromPriority),
      to: priorityLabel(entry.toPriority),
    };
  }
  if (entry.fromTitle !== null || entry.toTitle !== null) {
    return { ...base, kind: "title", from: entry.fromTitle, to: entry.toTitle };
  }
  if (entry.attachment) {
    return {
      ...base,
      kind: "attachment",
      title: entry.attachment.title,
      url: entry.attachment.url,
    };
  }
  return null;
}

const SYNC_SERVICE_NAMES: Record<string, string> = {
  slack: "Slack",
  github: "GitHub",
  jira: "Jira",
  intercom: "Intercom",
  zendesk: "Zendesk",
};

/** "Slack" for a comment written in Slack; a Linear comment merely mirrored there stays unmarked. */
function syncedVia(
  syncedWith: IssueDetailNode["comments"]["nodes"][number]["syncedWith"],
): string | null {
  const origin = (syncedWith ?? []).find(
    (entry) => entry.service !== "slack" || entry.metadata?.isFromSlack === true,
  );
  return origin ? (SYNC_SERVICE_NAMES[origin.service] ?? origin.service) : null;
}

/** Maps Linear's issue into the page's shape: comments and changes merged, oldest first. */
export function toLinearIssueDetail(node: IssueDetailNode): LinearIssueDetail {
  const startedPositions = node.team.states.nodes;
  const created: LinearIssueActivity = {
    id: `created:${node.id}`,
    createdAt: node.createdAt,
    actor: person(node.creator),
    kind: "created",
  };
  const comments: Array<LinearIssueActivity> = node.comments.nodes.map((comment) => ({
    id: comment.id,
    createdAt: comment.createdAt,
    actor: comment.externalUser
      ? { name: comment.externalUser.name, avatarUrl: comment.externalUser.avatarUrl }
      : actorOf(comment.user, comment.botActor),
    kind: "comment",
    body: comment.body,
    parentId: comment.parent?.id ?? null,
    via: syncedVia(comment.syncedWith),
    syncedThread: comment.externalThread
      ? {
          source: comment.externalThread.name ?? "Slack",
          displayName: comment.externalThread.displayName,
          url: comment.externalThread.url,
        }
      : null,
  }));
  const changes = node.history.nodes.flatMap((entry) => {
    const activity = historyActivity(entry, startedPositions);
    return activity ? [activity] : [];
  });
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    description: node.description ?? "",
    state: toLinearIssueState(node.state, startedPositions),
    priority: node.priority,
    priorityLabel: node.priorityLabel,
    assignee: person(node.assignee),
    creator: person(node.creator),
    team: node.team,
    project: node.project?.name ?? null,
    labels: node.labels.nodes,
    branchName: node.branchName,
    attachments: node.attachments.nodes,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt ?? node.createdAt,
    activityTruncated:
      node.comments.nodes.length >= ACTIVITY_PAGE_SIZE ||
      node.history.nodes.length >= ACTIVITY_PAGE_SIZE,
    // Linear leads with the creation even when older comments moved over with the issue.
    activity: [
      created,
      ...[...comments, ...changes].toSorted((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
    ],
  };
}

const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";
const REVIEW_URL_TTL_MS = 10 * 60 * 1_000;
const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/u;

const McpMessage = Schema.Struct({
  result: Schema.optional(
    Schema.Struct({
      isError: Schema.optional(Schema.Boolean),
      content: Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
    }),
  ),
});
const decodeMcpMessage = Schema.decodeUnknownOption(Schema.fromJsonString(McpMessage));
const decodeDiff = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ appUrl: Schema.optional(Schema.String) })),
);

/** The review page from an MCP `get_diff` answer, sent as JSON or as a server-sent event. */
export function reviewUrlFromMcpResponse(body: string): string | null {
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  const message = Option.getOrNull(decodeMcpMessage(data ? data.slice(6) : body));
  const text = message?.result?.isError ? undefined : message?.result?.content[0]?.text;
  const appUrl = text ? Option.getOrNull(decodeDiff(text))?.appUrl : undefined;
  return appUrl?.startsWith("https://linear.app/") ? appUrl : null;
}

const SIGNED_UPLOAD_TTL_SECONDS = 12 * 60 * 60;
/** Reused until this close to expiry; the page is re-read far more often than that. */
const SIGNED_UPLOAD_RENEW_MS = 60 * 60 * 1_000;
const LINEAR_UPLOAD_URL = /https:\/\/uploads\.linear\.app\/[^\s)"'<>]+/gu;

/**
 * Linear signs upload URLs afresh on every read. Handing the page a new
 * signature every 15 seconds would reload each image, so the first signed
 * URL for a file is kept until it nears expiry.
 */
export function makeSignedUploadCache() {
  const byPath = new Map<string, { readonly url: string; readonly expiresAt: number }>();
  return {
    stabilize(text: string, nowMs: number): string {
      for (const [path, entry] of byPath) {
        if (entry.expiresAt - nowMs < SIGNED_UPLOAD_RENEW_MS) byPath.delete(path);
      }
      return text.replace(LINEAR_UPLOAD_URL, (url) => {
        const path = url.split("?")[0] ?? url;
        const cached = byPath.get(path);
        if (cached) return cached.url;
        if (!url.includes("signature=")) return url;
        byPath.set(path, { url, expiresAt: nowMs + SIGNED_UPLOAD_TTL_SECONDS * 1_000 });
        return url;
      });
    },
  };
}

/**
 * Reads issues by identifier ("ENG-123") or UUID; Linear's `issue(id:)`
 * accepts both. Issues Linear does not return (deleted, no access) are
 * absent from the result map.
 */
export const makeLinearApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const signedUploads = makeSignedUploadCache();

  const request = (
    apiKey: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    client
      .execute(
        HttpClientRequest.post(LINEAR_GRAPHQL_URL).pipe(
          // Personal API keys go bare; OAuth access tokens need the Bearer scheme.
          HttpClientRequest.setHeaders({
            ...headers,
            Authorization: apiKey.startsWith("lin_oauth_") ? `Bearer ${apiKey}` : apiKey,
          }),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.mapError(() => new LinearApiError({ detail: "The Linear API request failed." })),
      );

  const reviewUrls = new Map<string, { readonly url: string | null; readonly until: number }>();

  /**
   * Linear's review page for a pull request, through its MCP server: the only
   * place it's exposed, and only to a person's sign-in (not API keys or apps).
   */
  const readReviewUrl = (token: string, pullRequestUrl: string, nowMs: number) => {
    const cached = reviewUrls.get(pullRequestUrl);
    if (cached && cached.until > nowMs) return Effect.succeed(cached.url);
    return client
      .execute(
        HttpClientRequest.post(LINEAR_MCP_URL).pipe(
          HttpClientRequest.setHeaders({
            Authorization: `Bearer ${token}`,
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-03-26",
          }),
          HttpClientRequest.bodyJsonUnsafe({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "get_diff", arguments: { urlOrId: pullRequestUrl } },
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.map(reviewUrlFromMcpResponse),
        Effect.timeout("8 seconds"),
        Effect.orElseSucceed(() => null),
        Effect.tap((url) =>
          Effect.sync(() =>
            reviewUrls.set(pullRequestUrl, { url, until: nowMs + REVIEW_URL_TTL_MS }),
          ),
        ),
      );
  };

  /** One issue with its description, attachments, and activity; null if Linear doesn't return it. */
  const readIssueDetail = Effect.fn("LinearApi.readIssueDetail")(function* (
    apiKey: string,
    reference: string,
    options: { readonly reviews: boolean } = { reviews: false },
  ) {
    const body = yield* request(
      apiKey,
      { query: ISSUE_DETAIL_QUERY, variables: { id: reference } },
      // Uploads need Linear sign-in; signed URLs let the page show images without it.
      { "public-file-urls-expire-in": String(SIGNED_UPLOAD_TTL_SECONDS) },
    );
    const decoded = yield* decodeIssueDetailResponse(body).pipe(
      Effect.mapError(
        () => new LinearApiError({ detail: "Linear returned an unexpected response." }),
      ),
    );
    if (decoded.data === undefined || decoded.data === null) {
      const message = decoded.errors?.[0]?.message ?? "Linear returned no data.";
      // Linear answers a missing or inaccessible issue with an error and no data.
      if (/not found|entity not found/iu.test(message)) return null;
      return yield* new LinearApiError({ detail: message });
    }
    if (decoded.data.issue === null) return null;
    const detail = toLinearIssueDetail(decoded.data.issue);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const stable = (text: string) => signedUploads.stabilize(text, now);
    const attachments = options.reviews
      ? yield* Effect.forEach(
          detail.attachments,
          (attachment) =>
            GITHUB_PULL_REQUEST_URL.test(attachment.url)
              ? readReviewUrl(apiKey, attachment.url, now).pipe(
                  Effect.map((reviewUrl) => ({ ...attachment, reviewUrl })),
                )
              : Effect.succeed(attachment),
          { concurrency: 4 },
        )
      : detail.attachments;
    return {
      ...detail,
      attachments,
      description: stable(detail.description),
      activity: detail.activity.map((entry) =>
        entry.kind === "comment" ? { ...entry, body: stable(entry.body) } : entry,
      ),
    };
  });

  const readChunk = Effect.fn("LinearApi.readChunk")(function* (
    apiKey: string,
    references: ReadonlyArray<string>,
  ) {
    const query = `query {${references
      .map(
        (reference, index) =>
          ` i${index}: issue(id: ${JSON.stringify(reference)}) { ${ISSUE_FIELDS} }`,
      )
      .join("")} }`;
    const body = yield* request(apiKey, { query });
    const decoded = yield* decodeIssuesResponse(body).pipe(
      Effect.mapError(
        () => new LinearApiError({ detail: "Linear returned an unexpected response." }),
      ),
    );
    // One missing issue fails only its alias; a response without data is an auth or query error.
    if (!decoded.data) {
      return yield* new LinearApiError({
        detail: decoded.errors?.[0]?.message ?? "Linear returned no data.",
      });
    }
    const issues = new Map<string, LinearIssue>();
    references.forEach((reference, index) => {
      const node = decoded.data?.[`i${index}`];
      if (!node) return;
      issues.set(reference, {
        id: node.id,
        identifier: node.identifier,
        title: node.title,
        url: node.url,
        updatedAt: node.updatedAt,
        state: toLinearIssueState(node.state, node.team?.states.nodes),
        assignee: node.assignee?.displayName.trim() || null,
      });
    });
    return issues;
  });

  const readIssues = Effect.fn("LinearApi.readIssues")(function* (
    apiKey: string,
    references: ReadonlyArray<string>,
  ) {
    const chunks: Array<ReadonlyArray<string>> = [];
    for (let index = 0; index < references.length; index += MAX_ISSUES_PER_REQUEST) {
      chunks.push(references.slice(index, index + MAX_ISSUES_PER_REQUEST));
    }
    const results = yield* Effect.forEach(chunks, (chunk) => readChunk(apiKey, chunk), {
      concurrency: 2,
    });
    return new Map(results.flatMap((result) => [...result]));
  });

  return { readIssues, readIssueDetail };
});
