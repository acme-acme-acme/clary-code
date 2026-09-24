import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";

export class LinearRequestFailed extends Schema.TaggedError<LinearRequestFailed>()(
  "LinearRequestFailed",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Linear ${this.operation} failed: ${this.detail}`;
  }
}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

const GraphqlResponse = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Unknown)),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});
const decodeGraphqlResponse = Schema.decodeUnknownEffect(GraphqlResponse);

interface LinearOAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

type LinearActivityContent =
  | { readonly type: "thought"; readonly body: string }
  | { readonly type: "elicitation"; readonly body: string }
  | { readonly type: "response"; readonly body: string }
  | { readonly type: "error"; readonly body: string };

/** Thin Linear API wrapper; every call takes the token it should act with. */
export const makeLinearClient = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const tokenRequest = (operation: string, form: Record<string, string>) =>
    httpClient
      .execute(HttpClientRequest.post(LINEAR_TOKEN_URL).pipe(HttpClientRequest.bodyUrlParams(form)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodeTokenResponse),
        Effect.timeout("8 seconds"),
        Effect.mapError((cause) => new LinearRequestFailed({ operation, detail: String(cause) })),
      );

  const exchangeCode = (config: LinearOAuthClientConfig, code: string) =>
    tokenRequest("token exchange", {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

  const refresh = (config: LinearOAuthClientConfig, refreshToken: string) =>
    tokenRequest("token refresh", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

  const revoke = (token: string) =>
    httpClient
      .execute(
        HttpClientRequest.post(LINEAR_REVOKE_URL).pipe(
          HttpClientRequest.bodyUrlParams({ token, token_type_hint: "access_token" }),
        ),
      )
      .pipe(Effect.timeout("5 seconds"), Effect.ignore);

  const graphql = Effect.fnUntraced(function* <A, E>(
    operation: string,
    token: string,
    query: string,
    variables: Record<string, unknown>,
    decode: (data: unknown) => Effect.Effect<A, E>,
  ) {
    const failed = (cause: unknown) =>
      new LinearRequestFailed({ operation, detail: String(cause) });
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(LINEAR_GRAPHQL_URL).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodeGraphqlResponse),
        Effect.timeout("8 seconds"),
        Effect.mapError(failed),
      );
    if (response.data == null) {
      return yield* new LinearRequestFailed({
        operation,
        detail: response.errors?.[0]?.message ?? "no data",
      });
    }
    return yield* decode(response.data).pipe(Effect.mapError(failed));
  });

  const ViewerOrganization = Schema.Struct({
    viewer: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      displayName: Schema.optional(Schema.String),
    }),
    organization: Schema.Struct({ id: Schema.String, name: Schema.String }),
  });

  /** For an app token `viewer` is the workspace's agent user; for a user token, that user. */
  const viewer = (token: string) =>
    graphql(
      "viewer",
      token,
      "query { viewer { id name displayName } organization { id name } }",
      {},
      Schema.decodeUnknownEffect(ViewerOrganization),
    );

  const createActivity = (
    token: string,
    input: {
      readonly agentSessionId: string;
      readonly content: LinearActivityContent;
      readonly ephemeral?: boolean;
      readonly signal?: "auth";
      readonly signalMetadata?: Record<string, unknown>;
    },
  ) =>
    graphql(
      "agentActivityCreate",
      token,
      "mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }",
      { input },
      () => Effect.void,
    );

  const setExternalUrls = (
    token: string,
    agentSessionId: string,
    externalUrls: ReadonlyArray<{ readonly label: string; readonly url: string }>,
  ) =>
    graphql(
      "agentSessionUpdate",
      token,
      "mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }",
      { id: agentSessionId, input: { externalUrls } },
      () => Effect.void,
    );

  const IssueStates = Schema.Struct({
    issue: Schema.Struct({
      state: Schema.Struct({ type: Schema.String }),
      team: Schema.Struct({
        states: Schema.Struct({
          nodes: Schema.Array(Schema.Struct({ id: Schema.String, position: Schema.Number })),
        }),
      }),
    }),
  });

  /**
   * Linear asks agents to move a delegated issue into the team's first
   * "started" state unless it is already started, completed, or canceled.
   */
  const markIssueStarted = (token: string, issueId: string) =>
    Effect.gen(function* () {
      const data = yield* graphql(
        "issue states",
        token,
        'query($id: String!) { issue(id: $id) { state { type } team { states(filter: { type: { eq: "started" } }) { nodes { id position } } } } }',
        { id: issueId },
        Schema.decodeUnknownEffect(IssueStates),
      );
      if (["started", "completed", "canceled"].includes(data.issue.state.type)) return;
      const first = data.issue.team.states.nodes.toSorted(
        (left, right) => left.position - right.position,
      )[0];
      if (!first) return;
      yield* graphql(
        "issueUpdate",
        token,
        "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
        { id: issueId, stateId: first.id },
        () => Effect.void,
      );
    });

  return {
    exchangeCode,
    refresh,
    revoke,
    viewer,
    createActivity,
    setExternalUrls,
    markIssueStarted,
  };
});

export type LinearClient = Effect.Success<typeof makeLinearClient>;
