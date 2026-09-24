import type {
  RelayLinearAuthorizeRequest,
  RelayLinearStatusResponse,
} from "@t3tools/contracts/relay";
import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { normalizeRelayIssuer } from "@t3tools/shared/relayJwt";
import { and, eq, isNull } from "drizzle-orm";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import {
  relayLinearAgentSessions,
  relayLinearInstallations,
  relayLinearUserLinks,
} from "../persistence/schema.ts";
import { LINEAR_AUTHORIZE_URL, makeLinearClient, type LinearClient } from "./LinearClient.ts";
import {
  openSecret,
  sealSecret,
  signOAuthState,
  verifyLinearWebhook,
  verifyOAuthState,
} from "./linearCrypto.ts";

export const LINEAR_OAUTH_CALLBACK_PATH = "/v1/linear/oauth/callback";
export const LINEAR_WEBHOOK_PATH = "/v1/linear/webhook";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1_000;
/** Queue messages are capped at 128 KB; Linear's prompt context can be long. */
const MAX_PROMPT_CHARS = 32_000;

export class LinearIntegrationError extends Schema.TaggedError<LinearIntegrationError>()(
  "LinearIntegrationError",
  {
    reason: Schema.Literals([
      "not_configured",
      "not_authorized",
      "persistence_failed",
      "upstream_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Linear integration error: ${this.reason}`;
  }
}

/** Sends a verified agent-session webhook to the queue so the webhook answers within Linear's 5s. */
export class LinearEventQueueSender extends Context.Service<
  LinearEventQueueSender,
  {
    readonly send: (body: LinearQueuedEvent) => Effect.Effect<void, Cloudflare.Queues.SendError>;
  }
>()("t3code-relay/linear/LinearIntegration/LinearEventQueueSender") {}

const LinearSessionIssue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  team: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.optional(Schema.String) }))),
});

/** The fields of an `AgentSessionEvent` webhook the relay acts on. */
const LinearQueuedEvent = Schema.Struct({
  action: Schema.String,
  organizationId: Schema.String,
  promptContext: Schema.optional(Schema.NullOr(Schema.String)),
  agentSession: Schema.Struct({
    id: Schema.String,
    creatorId: Schema.optional(Schema.NullOr(Schema.String)),
    creator: Schema.optional(
      Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) })),
    ),
    issue: Schema.optional(Schema.NullOr(LinearSessionIssue)),
  }),
});
export type LinearQueuedEvent = typeof LinearQueuedEvent.Type;
const decodeQueuedEvent = Schema.decodeUnknownEffect(LinearQueuedEvent);

export class LinearIntegration extends Context.Service<
  LinearIntegration,
  {
    readonly status: (
      userId: string,
    ) => Effect.Effect<RelayLinearStatusResponse, LinearIntegrationError>;
    readonly authorize: (
      userId: string,
      request: RelayLinearAuthorizeRequest,
    ) => Effect.Effect<{ readonly url: string }, LinearIntegrationError>;
    readonly updateLink: (
      userId: string,
      organizationId: string,
      environmentId: string,
    ) => Effect.Effect<boolean, LinearIntegrationError>;
    readonly unlink: (
      userId: string,
      organizationId: string,
    ) => Effect.Effect<boolean, LinearIntegrationError>;
    /** Returns where to send the browser: the hosted app's settings with an outcome flag. */
    readonly oauthCallback: (params: URLSearchParams) => Effect.Effect<string>;
    /** Returns the HTTP status to answer Linear with. */
    readonly receiveWebhook: (input: {
      readonly rawBody: string;
      readonly signature: string | undefined;
    }) => Effect.Effect<number>;
    /** Queue consumer for agent-session events. Never fails; outcomes land in Linear. */
    readonly processEvent: (body: unknown) => Effect.Effect<void>;
  }
>()("t3code-relay/linear/LinearIntegration") {}

/** Where the "Open in Otter Code" link on a Linear session points. */
function hostedThreadUrl(hostedAppUrl: string, environmentId: string, threadId: string) {
  return `${hostedAppUrl.replace(/\/+$/u, "")}/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

function linearSettingsUrl(hostedAppUrl: string, outcome?: string) {
  const url = new URL("/settings/connections", hostedAppUrl);
  if (outcome) url.searchParams.set("linear", outcome);
  return url.toString();
}

const isoAt = (epochMillis: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMillis));

const decodeWebhookBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const make = Effect.gen(function* () {
  const settings = yield* RelayConfiguration.RelayConfiguration;
  const db = yield* RelayDb.RelayDb;
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const connector = yield* EnvironmentConnector.EnvironmentConnector;
  const queue = yield* LinearEventQueueSender;
  const client: LinearClient = yield* makeLinearClient;
  const randomUuid = yield* Crypto.Crypto;
  const config = settings.linear ?? null;
  const redirectUri = `${normalizeRelayIssuer(settings.relayIssuer)}${LINEAR_OAUTH_CALLBACK_PATH}`;

  const persistence = (cause: unknown) =>
    new LinearIntegrationError({ reason: "persistence_failed", cause });

  const requireConfig = config
    ? Effect.succeed(config)
    : Effect.fail(new LinearIntegrationError({ reason: "not_configured" }));

  const oauthClient = (linear: RelayConfiguration.LinearConfiguration) => ({
    clientId: linear.clientId,
    clientSecret: Redacted.value(linear.clientSecret),
    redirectUri,
  });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const promise = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) => new LinearIntegrationError({ reason: "persistence_failed", cause }),
    });

  /**
   * The workspace's app token, refreshed when it is about to expire. Linear
   * rotates refresh tokens, so the row is only replaced if it still holds the
   * token this call started from; a concurrent refresh wins otherwise.
   */
  const accessTokenFor = Effect.fn("relay.linear.access_token")(function* (organizationId: string) {
    const linear = yield* requireConfig;
    const [row] = yield* db
      .select()
      .from(relayLinearInstallations)
      .where(
        and(
          eq(relayLinearInstallations.organizationId, organizationId),
          isNull(relayLinearInstallations.revokedAt),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(persistence));
    if (!row) return null;
    const sealingKey = Redacted.value(linear.tokenSealingKey);
    const accessToken = yield* promise(() => openSecret(sealingKey, row.accessTokenSealed));
    const expiresAt = row.accessTokenExpiresAt ? Date.parse(row.accessTokenExpiresAt) : null;
    const now = (yield* DateTime.now).epochMilliseconds;
    if (
      expiresAt === null ||
      expiresAt - now > TOKEN_REFRESH_MARGIN_MS ||
      !row.refreshTokenSealed
    ) {
      return accessToken;
    }
    const refreshToken = yield* promise(() => openSecret(sealingKey, row.refreshTokenSealed!));
    const refreshed = yield* client
      .refresh(oauthClient(linear), refreshToken)
      .pipe(
        Effect.mapError(
          (cause) => new LinearIntegrationError({ reason: "upstream_failed", cause }),
        ),
      );
    yield* db
      .update(relayLinearInstallations)
      .set({
        accessTokenSealed: yield* promise(() => sealSecret(sealingKey, refreshed.access_token)),
        refreshTokenSealed: refreshed.refresh_token
          ? yield* promise(() => sealSecret(sealingKey, refreshed.refresh_token!))
          : row.refreshTokenSealed,
        accessTokenExpiresAt:
          refreshed.expires_in === undefined ? null : isoAt(now + refreshed.expires_in * 1_000),
        updatedAt: isoAt(now),
      })
      .where(
        and(
          eq(relayLinearInstallations.organizationId, organizationId),
          eq(relayLinearInstallations.accessTokenSealed, row.accessTokenSealed),
        ),
      )
      .pipe(Effect.mapError(persistence));
    return refreshed.access_token;
  });

  const status: LinearIntegration["Service"]["status"] = Effect.fn("relay.linear.status")(
    function* (userId) {
      if (!config) return { available: false, links: [] };
      const rows = yield* db
        .select()
        .from(relayLinearUserLinks)
        .where(eq(relayLinearUserLinks.userId, userId))
        .pipe(Effect.mapError(persistence));
      const installed = yield* db
        .select({ organizationId: relayLinearInstallations.organizationId })
        .from(relayLinearInstallations)
        .where(isNull(relayLinearInstallations.revokedAt))
        .pipe(Effect.mapError(persistence));
      const installedIds = new Set(installed.map((row) => row.organizationId));
      return {
        available: true,
        links: rows.map((row) => ({
          organizationId: row.organizationId,
          organizationName: row.organizationName,
          linearUserName: row.linearUserName,
          environmentId: EnvironmentId.make(row.environmentId),
          agentInstalled: installedIds.has(row.organizationId),
        })),
      };
    },
  );

  const requireOwnEnvironment = Effect.fn("relay.linear.require_own_environment")(function* (
    userId: string,
    environmentId: string,
  ) {
    const link = yield* links
      .getForUser({ userId, environmentId })
      .pipe(Effect.mapError(persistence));
    if (!link) return yield* new LinearIntegrationError({ reason: "not_authorized" });
  });

  const authorize: LinearIntegration["Service"]["authorize"] = Effect.fn("relay.linear.authorize")(
    function* (userId, request) {
      const linear = yield* requireConfig;
      if (request.kind === "link") {
        if (!request.environmentId) {
          return yield* new LinearIntegrationError({ reason: "not_authorized" });
        }
        yield* requireOwnEnvironment(userId, request.environmentId);
      }
      const now = yield* DateTime.now;
      const nonce = yield* randomUuid.randomUUIDv4.pipe(Effect.mapError(persistence));
      const state = yield* promise(() =>
        signOAuthState(Redacted.value(linear.stateSigningKey), {
          userId,
          kind: request.kind,
          environmentId: request.environmentId ?? null,
          exp: Math.floor(now.epochMilliseconds / 1_000) + OAUTH_STATE_TTL_SECONDS,
          nonce,
        }),
      );
      const url = new URL(LINEAR_AUTHORIZE_URL);
      url.searchParams.set("client_id", linear.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      if (request.kind === "install") {
        url.searchParams.set("scope", "read,write,app:assignable,app:mentionable");
        url.searchParams.set("actor", "app");
      } else {
        url.searchParams.set("scope", "read");
      }
      return { url: url.toString() };
    },
  );

  const updateLink: LinearIntegration["Service"]["updateLink"] = Effect.fn(
    "relay.linear.update_link",
  )(function* (userId, organizationId, environmentId) {
    yield* requireOwnEnvironment(userId, environmentId);
    const updated = yield* db
      .update(relayLinearUserLinks)
      .set({ environmentId, updatedAt: yield* nowIso })
      .where(
        and(
          eq(relayLinearUserLinks.organizationId, organizationId),
          eq(relayLinearUserLinks.userId, userId),
        ),
      )
      .returning({ linearUserId: relayLinearUserLinks.linearUserId })
      .pipe(Effect.mapError(persistence));
    return updated.length > 0;
  });

  const unlink: LinearIntegration["Service"]["unlink"] = Effect.fn("relay.linear.unlink")(
    function* (userId, organizationId) {
      const deleted = yield* db
        .delete(relayLinearUserLinks)
        .where(
          and(
            eq(relayLinearUserLinks.organizationId, organizationId),
            eq(relayLinearUserLinks.userId, userId),
          ),
        )
        .returning({ linearUserId: relayLinearUserLinks.linearUserId })
        .pipe(Effect.mapError(persistence));
      return deleted.length > 0;
    },
  );

  const completeOAuth = Effect.fn("relay.linear.complete_oauth")(function* (
    params: URLSearchParams,
  ) {
    const linear = yield* requireConfig;
    const code = params.get("code");
    const stateParam = params.get("state");
    if (!code || !stateParam) return "cancelled";
    const now = yield* DateTime.now;
    const state = yield* promise(() =>
      verifyOAuthState(
        Redacted.value(linear.stateSigningKey),
        stateParam,
        Math.floor(now.epochMilliseconds / 1_000),
      ),
    );
    if (!state) return "error";
    const token = yield* client
      .exchangeCode(oauthClient(linear), code)
      .pipe(
        Effect.mapError(
          (cause) => new LinearIntegrationError({ reason: "upstream_failed", cause }),
        ),
      );
    const viewer = yield* client
      .viewer(token.access_token)
      .pipe(
        Effect.mapError(
          (cause) => new LinearIntegrationError({ reason: "upstream_failed", cause }),
        ),
      );
    const timestamp = DateTime.formatIso(now);
    if (state.kind === "install") {
      const sealingKey = Redacted.value(linear.tokenSealingKey);
      const values = {
        organizationName: viewer.organization.name,
        appUserId: viewer.viewer.id,
        accessTokenSealed: yield* promise(() => sealSecret(sealingKey, token.access_token)),
        refreshTokenSealed: token.refresh_token
          ? yield* promise(() => sealSecret(sealingKey, token.refresh_token!))
          : null,
        accessTokenExpiresAt:
          token.expires_in === undefined
            ? null
            : isoAt(now.epochMilliseconds + token.expires_in * 1_000),
        installedByUserId: state.userId,
        revokedAt: null,
        updatedAt: timestamp,
      };
      yield* db
        .insert(relayLinearInstallations)
        .values({ organizationId: viewer.organization.id, createdAt: timestamp, ...values })
        .onConflictDoUpdate({ target: relayLinearInstallations.organizationId, set: values })
        .pipe(Effect.mapError(persistence));
      return "installed";
    }
    // Linking only needs to learn who the user is; drop their token straight away.
    yield* client.revoke(token.access_token);
    if (!state.environmentId) return "error";
    yield* requireOwnEnvironment(state.userId, state.environmentId);
    const values = {
      linearUserName: viewer.viewer.displayName ?? viewer.viewer.name,
      organizationName: viewer.organization.name,
      userId: state.userId,
      environmentId: state.environmentId,
      updatedAt: timestamp,
    };
    yield* db
      .insert(relayLinearUserLinks)
      .values({
        organizationId: viewer.organization.id,
        linearUserId: viewer.viewer.id,
        createdAt: timestamp,
        ...values,
      })
      .onConflictDoUpdate({
        target: [relayLinearUserLinks.organizationId, relayLinearUserLinks.linearUserId],
        set: values,
      })
      .pipe(Effect.mapError(persistence));
    return "linked";
  });

  const oauthCallback: LinearIntegration["Service"]["oauthCallback"] = (params) =>
    completeOAuth(params).pipe(
      Effect.catch((error) =>
        Effect.logWarning("linear oauth callback failed", { error }).pipe(Effect.as("error")),
      ),
      Effect.map((outcome) =>
        linearSettingsUrl(config?.hostedAppUrl ?? DEFAULT_HOSTED_APP_URL, outcome),
      ),
    );

  const receiveWebhook: LinearIntegration["Service"]["receiveWebhook"] = Effect.fn(
    "relay.linear.receive_webhook",
  )(function* (input) {
    if (!config) return 404;
    const decoded = decodeWebhookBody(input.rawBody);
    if (decoded._tag === "None") return 400;
    const body = decoded.value;
    const now = yield* DateTime.now;
    const verified = yield* Effect.promise(() =>
      verifyLinearWebhook({
        secret: Redacted.value(config.webhookSecret),
        rawBody: input.rawBody,
        signature: input.signature,
        webhookTimestamp: body.webhookTimestamp,
        nowEpochMillis: now.epochMilliseconds,
      }),
    );
    if (!verified) return 401;
    yield* Effect.annotateCurrentSpan({
      "relay.linear.webhook_type": String(body.type),
      "relay.linear.webhook_action": String(body.action),
    });
    if (body.type === "OAuthApp" && body.action === "revoked") {
      const organizationId = typeof body.organizationId === "string" ? body.organizationId : null;
      if (organizationId) {
        yield* db
          .update(relayLinearInstallations)
          .set({ revokedAt: yield* nowIso, updatedAt: yield* nowIso })
          .where(eq(relayLinearInstallations.organizationId, organizationId))
          .pipe(Effect.ignore);
      }
      return 200;
    }
    if (body.type !== "AgentSessionEvent") return 200;
    const event = yield* decodeQueuedEvent(body).pipe(Effect.option);
    if (event._tag === "None") return 200;
    const promptContext = event.value.promptContext ?? null;
    const enqueued = yield* queue
      .send({
        ...event.value,
        promptContext: promptContext ? promptContext.slice(0, MAX_PROMPT_CHARS) : null,
      })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logError("could not enqueue linear event", { cause }).pipe(Effect.as(false)),
        ),
      );
    // A non-200 makes Linear redeliver, which is what we want if the queue is down.
    return enqueued ? 200 : 503;
  });

  const postActivity = (
    token: string,
    agentSessionId: string,
    content: Parameters<LinearClient["createActivity"]>[1]["content"],
    extra?: {
      readonly ephemeral?: boolean;
      readonly signal?: "auth";
      readonly signalMetadata?: Record<string, unknown>;
    },
  ) =>
    client
      .createActivity(token, { agentSessionId, content, ...extra })
      .pipe(Effect.catch((error) => Effect.logWarning("linear activity failed", { error })));

  const recordSession = (
    agentSessionId: string,
    values: Partial<typeof relayLinearAgentSessions.$inferInsert>,
  ) =>
    nowIso.pipe(
      Effect.flatMap((updatedAt) =>
        db
          .update(relayLinearAgentSessions)
          .set({ ...values, updatedAt })
          .where(eq(relayLinearAgentSessions.agentSessionId, agentSessionId)),
      ),
      Effect.ignore,
    );

  const handleCreated = Effect.fn("relay.linear.session_created")(function* (
    event: LinearQueuedEvent,
    token: string,
    linear: RelayConfiguration.LinearConfiguration,
  ) {
    const sessionId = event.agentSession.id;
    const issue = event.agentSession.issue;
    if (!issue) {
      return yield* postActivity(token, sessionId, {
        type: "error",
        body: "Otter Code works on issues. Delegate an issue to Otter, or mention Otter on one.",
      });
    }
    // One row per session: a redelivered webhook must not start a second thread.
    const timestamp = yield* nowIso;
    const inserted = yield* db
      .insert(relayLinearAgentSessions)
      .values({
        agentSessionId: sessionId,
        organizationId: event.organizationId,
        issueIdentifier: issue.identifier,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing()
      .returning({ agentSessionId: relayLinearAgentSessions.agentSessionId })
      .pipe(Effect.mapError(persistence));
    if (inserted.length === 0) return;

    const creatorId = event.agentSession.creatorId ?? null;
    if (!creatorId) {
      yield* recordSession(sessionId, { status: "failed" });
      return yield* postActivity(token, sessionId, {
        type: "error",
        body: "Otter Code runs issues that a person delegates after linking their Otter Code account. Issues delegated by automations are not supported yet.",
      });
    }
    const [link] = yield* db
      .select()
      .from(relayLinearUserLinks)
      .where(
        and(
          eq(relayLinearUserLinks.organizationId, event.organizationId),
          eq(relayLinearUserLinks.linearUserId, creatorId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(persistence));
    if (!link) {
      yield* recordSession(sessionId, { status: "failed" });
      return yield* postActivity(
        token,
        sessionId,
        {
          type: "elicitation",
          body: "Link your Otter Code account so delegated issues can run on your machine, then delegate this issue again.",
        },
        {
          signal: "auth",
          signalMetadata: {
            url: linearSettingsUrl(linear.hostedAppUrl, "link"),
            userId: creatorId,
            providerName: "Otter Code",
          },
        },
      );
    }
    yield* recordSession(sessionId, { userId: link.userId, environmentId: link.environmentId });

    const launched = yield* connector
      .linearSession({
        userId: link.userId,
        environmentId: link.environmentId,
        agentSessionId: sessionId,
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          teamKey: issue.team?.key ?? null,
        },
        prompt: event.promptContext ?? "",
        creatorName: event.agentSession.creator?.name ?? null,
      })
      .pipe(Effect.result);

    if (launched._tag === "Failure") {
      yield* recordSession(sessionId, { status: "failed" });
      const failure = launched.failure;
      const body =
        failure._tag === "EnvironmentMintRequestFailed" ||
        failure._tag === "EnvironmentMintRequestTimedOut"
          ? "Your Otter Code machine is offline or unreachable. Start Otter Code on it, then delegate the issue again."
          : failure._tag === "EnvironmentConnectNotAuthorized"
            ? "The machine linked for Linear is not reachable through Otter Connect. Check Settings → Connections in Otter Code."
            : "Otter Code could not start a thread for this issue.";
      yield* Effect.logWarning("linear session launch failed", { failure });
      return yield* postActivity(token, sessionId, { type: "error", body });
    }
    const result = launched.success;
    if (result.outcome === "no_project" || result.threadId === null) {
      yield* recordSession(sessionId, { status: "failed" });
      return yield* postActivity(token, sessionId, {
        type: "error",
        body: `Choose which project Linear issues run in: Settings → Integrations → Linear in Otter Code on ${result.environmentLabel}. Then delegate the issue again.`,
      });
    }
    yield* recordSession(sessionId, { status: "launched", threadId: result.threadId });
    yield* client
      .setExternalUrls(token, sessionId, [
        {
          label: "Open in Otter Code",
          url: hostedThreadUrl(linear.hostedAppUrl, link.environmentId, result.threadId),
        },
      ])
      .pipe(Effect.catch((error) => Effect.logWarning("linear external url failed", { error })));
    yield* postActivity(token, sessionId, {
      type: "thought",
      body: `Started a thread on ${result.environmentLabel}. Follow along in Otter Code.`,
    });
    yield* client
      .markIssueStarted(token, issue.id)
      .pipe(
        Effect.catch((error) => Effect.logWarning("linear issue state update failed", { error })),
      );
  });

  const handlePrompted = Effect.fn("relay.linear.session_prompted")(function* (
    event: LinearQueuedEvent,
    token: string,
    linear: RelayConfiguration.LinearConfiguration,
  ) {
    const [session] = yield* db
      .select()
      .from(relayLinearAgentSessions)
      .where(eq(relayLinearAgentSessions.agentSessionId, event.agentSession.id))
      .limit(1)
      .pipe(Effect.mapError(persistence));
    const threadUrl =
      session?.environmentId && session.threadId
        ? hostedThreadUrl(linear.hostedAppUrl, session.environmentId, session.threadId)
        : null;
    yield* postActivity(token, event.agentSession.id, {
      type: "thought",
      body: threadUrl
        ? `Replies and stop requests from Linear don't reach Otter Code yet. Continue in the thread: ${threadUrl}`
        : "Replies from Linear don't reach Otter Code yet. Delegate the issue again to start a new thread.",
    });
  });

  const processEvent: LinearIntegration["Service"]["processEvent"] = (body) =>
    Effect.gen(function* () {
      const linear = yield* requireConfig;
      const event = yield* decodeQueuedEvent(body);
      yield* Effect.annotateCurrentSpan({
        "relay.linear.agent_session_id": event.agentSession.id,
        "relay.linear.action": event.action,
      });
      const token = yield* accessTokenFor(event.organizationId);
      if (token === null) {
        return yield* Effect.logWarning("linear event for a workspace without an installation", {
          organizationId: event.organizationId,
        });
      }
      if (event.action === "created") {
        // Linear marks a session unresponsive without an activity within 10s.
        yield* postActivity(
          token,
          event.agentSession.id,
          { type: "thought", body: "Handing this to Otter Code…" },
          { ephemeral: true },
        );
        return yield* handleCreated(event, token, linear);
      }
      if (event.action === "prompted") return yield* handlePrompted(event, token, linear);
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("linear event processing failed", { cause })),
      Effect.withSpan("relay.linear.process_event"),
    );

  return LinearIntegration.of({
    status,
    authorize,
    updateLink,
    unlink,
    oauthCallback,
    receiveWebhook,
    processEvent,
  });
});

export const layer = Layer.effect(LinearIntegration, make);
