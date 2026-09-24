import type { LinearIssueStateType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
/** Aliased lookups per request; Linear caps a single query's complexity. */
const MAX_ISSUES_PER_REQUEST = 50;

export class LinearApiError extends Schema.TaggedError<LinearApiError>()("LinearApiError", {
  detail: Schema.String,
}) {}

const IssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
  state: Schema.Struct({ name: Schema.String, type: Schema.String, color: Schema.String }),
  assignee: Schema.NullOr(Schema.Struct({ displayName: Schema.String })),
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
  readonly state: {
    readonly name: string;
    readonly type: LinearIssueStateType;
    readonly color: string;
  };
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

const ISSUE_FIELDS =
  "id identifier title url updatedAt state { name type color } assignee { displayName }";

/**
 * Reads issues by identifier ("ENG-123") or UUID; Linear's `issue(id:)`
 * accepts both. Issues Linear does not return (deleted, no access) are
 * absent from the result map.
 */
export const makeLinearApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

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
    const body = yield* client
      .execute(
        HttpClientRequest.post(LINEAR_GRAPHQL_URL).pipe(
          // Personal API keys go bare; OAuth access tokens need the Bearer scheme.
          HttpClientRequest.setHeader(
            "Authorization",
            apiKey.startsWith("lin_oauth_") ? `Bearer ${apiKey}` : apiKey,
          ),
          HttpClientRequest.bodyJsonUnsafe({ query }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.mapError(() => new LinearApiError({ detail: "The Linear API request failed." })),
      );
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
        state: {
          name: node.state.name,
          type: (KNOWN_STATE_TYPES.has(node.state.type)
            ? node.state.type
            : "unknown") as LinearIssueStateType,
          color: node.state.color,
        },
        assignee: node.assignee?.displayName ?? null,
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

  return { readIssues };
});
