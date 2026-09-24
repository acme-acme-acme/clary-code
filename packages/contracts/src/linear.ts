import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Linear groups workflow states into these fixed types; names and colors are
 * per-team. Unknown future types decode as "unknown" rather than failing.
 */
export const LinearIssueStateType = Schema.Literals([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "unknown",
]);
export type LinearIssueStateType = typeof LinearIssueStateType.Type;

export const LinearIssueState = Schema.Struct({
  name: TrimmedNonEmptyString,
  type: LinearIssueStateType,
  color: Schema.String,
  /**
   * How far along a `started` state is among its team's started states, 0–1;
   * Linear draws it as the pie in the state icon.
   */
  progress: Schema.optional(Schema.Number),
});
export type LinearIssueState = typeof LinearIssueState.Type;

/** Issue state persisted on a link by the sync reactor; null until first sync. */
export const ThreadLinearIssueSnapshot = Schema.Struct({
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  state: LinearIssueState,
  assignee: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: Schema.NullOr(IsoDateTime),
  syncedAt: IsoDateTime,
});
export type ThreadLinearIssueSnapshot = typeof ThreadLinearIssueSnapshot.Type;

/** Who created a thread ↔ Linear issue link. `delegated` means Linear handed
 * the issue to the Otter agent, which started the thread. */
export const ThreadLinearIssueLinkSource = Schema.Literals(["manual", "agent", "delegated"]);
export type ThreadLinearIssueLinkSource = typeof ThreadLinearIssueLinkSource.Type;

/**
 * `identifier` ("ENG-123") is what people type and search, but it changes
 * when an issue moves teams, so links are keyed by it only until the first
 * sync fills in the stable `issueId`.
 */
export const ThreadLinearIssueLink = Schema.Struct({
  identifier: TrimmedNonEmptyString,
  issueId: Schema.NullOr(TrimmedNonEmptyString),
  url: TrimmedNonEmptyString,
  source: ThreadLinearIssueLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadLinearIssueSnapshot),
});
export type ThreadLinearIssueLink = typeof ThreadLinearIssueLink.Type;

const LINEAR_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-[1-9][0-9]*$/u;

/** "eng-123" → "ENG-123"; null when the text is not an issue identifier. */
export function normalizeLinearIssueIdentifier(value: string): string | null {
  const trimmed = value.trim();
  return LINEAR_IDENTIFIER_PATTERN.test(trimmed) ? trimmed.toUpperCase() : null;
}

/** Accepts "ENG-123" or a linear.app issue URL. */
export function parseLinearIssueReference(
  value: string,
): { readonly identifier: string; readonly url: string | null } | null {
  const trimmed = value.trim();
  const identifier = normalizeLinearIssueIdentifier(trimmed);
  if (identifier) return { identifier, url: null };
  const match = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z0-9]+-[0-9]+)(?:[/?#]|$)/u.exec(
    trimmed,
  );
  const fromUrl = match?.[1] ? normalizeLinearIssueIdentifier(match[1]) : null;
  return fromUrl ? { identifier: fromUrl, url: trimmed.split(/[?#]/u)[0]! } : null;
}

/** Workspace-less issue URL for links made before the first sync fills in the real one. */
export function linearIssueUrl(identifier: string): string {
  return `https://linear.app/issue/${identifier}`;
}

/**
 * The first message of a thread started from a Linear delegation. Placeholders
 * follow Linear's own prompt templates: `{{context}}` is Linear's prepared issue
 * context (description, comments, guidance).
 */
export const DEFAULT_LINEAR_PROMPT_TEMPLATE = [
  "Work on Linear issue {{issue.identifier}} ({{issue.url}}).",
  "",
  "{{context}}",
  "",
  "Open a pull request when the change is ready.",
].join("\n");

export const LINEAR_PROMPT_TEMPLATE_PLACEHOLDERS = [
  "issue.identifier",
  "issue.title",
  "issue.url",
  "issue.branchName",
  "context",
] as const;
export type LinearPromptTemplateValues = Record<
  (typeof LINEAR_PROMPT_TEMPLATE_PLACEHOLDERS)[number],
  string
>;

/** Fills `{{placeholder}}`s; unknown placeholders stay as written. An empty template means the default. */
export function renderLinearPromptTemplate(
  template: string,
  values: LinearPromptTemplateValues,
): string {
  const source = template.trim().length > 0 ? template : DEFAULT_LINEAR_PROMPT_TEMPLATE;
  return source
    .replace(/\{\{\s*([\w.]+)\s*\}\}/gu, (match, key: string) =>
      Object.hasOwn(values, key) ? values[key as keyof LinearPromptTemplateValues] : match,
    )
    .trim();
}

export const LinearIssueDetailPerson = Schema.Struct({
  name: TrimmedNonEmptyString,
  avatarUrl: Schema.NullOr(Schema.String),
});
export type LinearIssueDetailPerson = typeof LinearIssueDetailPerson.Type;

const LinearIssueActivityBase = {
  id: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  /** Who did it; a bot's or integration's name when no person did. */
  actor: Schema.NullOr(LinearIssueDetailPerson),
} as const;

const LinearIssueStateChip = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
  type: Schema.optional(LinearIssueStateType),
  progress: Schema.optional(Schema.Number),
});

/** One entry of an issue's activity log: a comment, or a change Linear recorded. */
export const LinearIssueActivity = Schema.Union([
  Schema.Struct({
    ...LinearIssueActivityBase,
    kind: Schema.Literal("created"),
  }),
  Schema.Struct({
    ...LinearIssueActivityBase,
    kind: Schema.Literal("comment"),
    body: Schema.String,
    /** Set for replies in a comment thread. */
    parentId: Schema.NullOr(TrimmedNonEmptyString),
    /** The service a synced comment came through, e.g. "Slack". */
    via: Schema.NullOr(Schema.String),
    /** On a thread's first comment when the thread is synced with Slack or another service. */
    syncedThread: Schema.NullOr(
      Schema.Struct({
        source: Schema.String,
        /** e.g. the Slack channel, "#design". */
        displayName: Schema.NullOr(Schema.String),
        url: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  Schema.Struct({
    ...LinearIssueActivityBase,
    kind: Schema.Literal("state"),
    from: Schema.NullOr(LinearIssueStateChip),
    to: Schema.NullOr(LinearIssueStateChip),
  }),
  Schema.Struct({
    ...LinearIssueActivityBase,
    kind: Schema.Literal("assignee"),
    from: Schema.NullOr(Schema.String),
    to: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...LinearIssueActivityBase,
    kind: Schema.Literal("labels"),
    added: Schema.Array(Schema.String),
    removed: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    ...LinearIssueActivityBase,
    kind: Schema.Literal("priority"),
    from: Schema.NullOr(Schema.String),
    to: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...LinearIssueActivityBase,
    kind: Schema.Literal("title"),
    from: Schema.NullOr(Schema.String),
    to: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...LinearIssueActivityBase,
    kind: Schema.Literal("attachment"),
    title: Schema.String,
    url: Schema.String,
  }),
]);
export type LinearIssueActivity = typeof LinearIssueActivity.Type;

/** An issue as the Linear issue page shows it, read live with the environment's API key. */
export const LinearIssueDetail = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: Schema.String,
  url: Schema.String,
  description: Schema.String,
  state: LinearIssueState,
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: Schema.Number,
  priorityLabel: Schema.String,
  assignee: Schema.NullOr(LinearIssueDetailPerson),
  creator: Schema.NullOr(LinearIssueDetailPerson),
  team: Schema.Struct({ key: Schema.String, name: Schema.String }),
  project: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.String })),
  branchName: Schema.String,
  attachments: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      subtitle: Schema.NullOr(Schema.String),
      url: Schema.String,
      sourceType: Schema.NullOr(Schema.String),
      /** Linear's review page for a linked pull request; only with a Linear sign-in. */
      reviewUrl: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Oldest first. */
  activity: Schema.Array(LinearIssueActivity),
  /** Linear had older comments or changes than the page read. */
  activityTruncated: Schema.Boolean,
});
export type LinearIssueDetail = typeof LinearIssueDetail.Type;

export const LinearIssueDetailInput = Schema.Struct({
  /** An identifier such as "ENG-123", or the issue's UUID. */
  reference: TrimmedNonEmptyString,
});
export type LinearIssueDetailInput = typeof LinearIssueDetailInput.Type;

/** `not_configured`: the environment has no Linear API key. */
export class LinearIssueDetailError extends Schema.TaggedError<LinearIssueDetailError>()(
  "LinearIssueDetailError",
  {
    reason: Schema.Literals(["not_configured", "not_found", "unavailable"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** A Linear issue that changed (fields, comments, or recorded history), pushed as it happens. */
export const LinearIssueChange = Schema.Struct({
  issueId: TrimmedNonEmptyString,
  identifier: Schema.NullOr(Schema.String),
});
export type LinearIssueChange = typeof LinearIssueChange.Type;
