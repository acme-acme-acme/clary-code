import type { LinearIssueChange } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const LINEAR_REALTIME_URL = "wss://api.linear.app/graphql";
/** Linear acks before it checks a subscription, so a connection counts as live once it lasts. */
const LIVE_AFTER_MS = 5_000;
/** A connection that lasted this long was healthy; the next drop reconnects quickly again. */
const STABLE_AFTER_MS = 60_000;
const CREDENTIAL_RECHECK = "1 minute";
/** Pings keep the socket honest: a sleeping laptop leaves it half-open without a close event. */
const KEEPALIVE_INTERVAL = "30 seconds";

/**
 * Linear's GraphQL subscriptions are workspace-wide; the feed only needs to
 * know which issue changed. Comments and recorded changes carry their issue.
 */
const SUBSCRIPTIONS = [
  "subscription { issueUpdated { id identifier } }",
  "subscription { commentCreated { issue { id identifier } } }",
  "subscription { commentUpdated { issue { id identifier } } }",
  "subscription { issueHistoryCreated { issue { id identifier } } }",
];

const IssueRef = Schema.Struct({ id: Schema.String, identifier: Schema.optional(Schema.String) });
const Message = Schema.Struct({
  type: Schema.String,
  payload: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        data: Schema.optional(
          Schema.NullOr(
            Schema.Record(
              Schema.String,
              Schema.NullOr(
                Schema.Union([Schema.Struct({ issue: Schema.NullOr(IssueRef) }), IssueRef]),
              ),
            ),
          ),
        ),
      }),
    ),
  ),
});
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The issue a `next` subscription message is about, or null for any other message. */
export function issueChangeFromMessage(raw: string): LinearIssueChange | null {
  const message = Option.getOrNull(decodeMessage(raw));
  if (message?.type !== "next") return null;
  for (const value of Object.values(message.payload?.data ?? {})) {
    const issue = value && "issue" in value ? value.issue : value;
    if (issue) return { issueId: issue.id, identifier: issue.identifier ?? null };
  }
  return null;
}

/** Whether a close code means Linear refused the token: 4002 unauthenticated, 4003 forbidden, 44xx. */
export const rejectsCredential = (code: number) =>
  code === 4002 || code === 4003 || (code >= 4400 && code < 4500);

/** 10s after the first failed connection, doubling to 5 minutes, so a refusing Linear isn't hammered. */
export const reconnectDelayMs = (failures: number) =>
  Math.min(10_000 * 2 ** Math.max(failures - 1, 0), 300_000);

/**
 * The credential the feed connects with: the sign-in, unless Linear already
 * refused that exact token for subscriptions, then the API key.
 */
export function linearFeedCredential(
  credentials: { readonly user: string | null; readonly apiKey: string | null },
  rejectedUserToken: string | null,
): { readonly token: string; readonly kind: "sign-in" | "API key" } | null {
  if (credentials.user !== null && credentials.user !== rejectedUserToken) {
    return { token: credentials.user, kind: "sign-in" };
  }
  return credentials.apiKey === null ? null : { token: credentials.apiKey, kind: "API key" };
}

/** How a live connection ended. */
class LinearLiveFeedClosed extends Schema.TaggedError<LinearLiveFeedClosed>()(
  "LinearLiveFeedClosed",
  { code: Schema.Number, reason: Schema.String },
) {}

type FeedEvent =
  | { readonly kind: "connected" }
  | { readonly kind: "change"; readonly change: LinearIssueChange };

/**
 * One live connection to Linear's subscription endpoint (graphql-transport-ws).
 * Linear authenticates subscriptions only through the handshake's
 * Authorization header, which Node's WebSocket accepts as `headers`.
 */
const connect = (token: string) =>
  Stream.callback<FeedEvent, LinearLiveFeedClosed>((queue) =>
    Effect.gen(function* () {
      const connection = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const state = { messages: 0 };
          const init = {
            protocols: ["graphql-transport-ws"],
            headers: { Authorization: token.startsWith("lin_oauth_") ? `Bearer ${token}` : token },
          };
          const socket = new WebSocket(LINEAR_REALTIME_URL, init as unknown as string[]);
          const send = (message: unknown) => socket.send(encodeMessage(message));
          socket.addEventListener("open", () => send({ type: "connection_init", payload: {} }));
          socket.addEventListener("message", (event) => {
            state.messages += 1;
            const raw = String(event.data);
            const type = Option.getOrNull(decodeMessage(raw))?.type;
            if (type === "connection_ack") {
              Queue.offerUnsafe(queue, { kind: "connected" });
              SUBSCRIPTIONS.forEach((query, index) =>
                send({ id: String(index + 1), type: "subscribe", payload: { query } }),
              );
            } else if (type === "ping") {
              send({ type: "pong" });
            } else if (type === "error") {
              // A rejected subscription would otherwise idle forever.
              socket.close(4403, "subscription rejected");
            } else {
              const change = issueChangeFromMessage(raw);
              if (change) Queue.offerUnsafe(queue, { kind: "change", change });
            }
          });
          socket.addEventListener("close", (event) =>
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(
                new LinearLiveFeedClosed({
                  code: event.code,
                  reason: event.reason,
                }),
              ),
            ),
          );
          return { socket, send, state };
        }),
        ({ socket }) => Effect.sync(() => socket.close()),
      );
      // Ping every interval; nothing heard since the last ping (not even its pong) means stale.
      let seen = 0;
      yield* Effect.sync(() => {
        const { socket, send, state } = connection;
        if (state.messages === seen) return socket.close(4000, "no reply to keepalive");
        seen = state.messages;
        if (socket.readyState === WebSocket.OPEN) send({ type: "ping" });
      }).pipe(Effect.delay(KEEPALIVE_INTERVAL), Effect.forever, Effect.forkScoped);
    }),
  );

/**
 * Issue changes from Linear as they happen, while this environment can read
 * Linear. Undocumented by Linear, so everything that reads issues keeps
 * polling as a fallback; the feed only makes updates arrive sooner.
 */
export const makeLinearLiveFeed = Effect.fn("LinearLiveFeed.make")(function* (
  /** Both credentials from `makeLinearCredentials`: the sign-in is tried first. */
  credentials: Effect.Effect<{ readonly user: string | null; readonly apiKey: string | null }>,
) {
  const changes = yield* PubSub.unbounded<LinearIssueChange>();
  /** When the current connection was acked; null while there is none. */
  let connectedAt: number | null = null;
  /** Connections in a row that dropped before they were stable. */
  let failures = 0;
  // Linear may refuse a sign-in token for subscriptions; then use the API key until it changes.
  let rejectedUserToken: string | null = null;

  const choose = credentials.pipe(
    Effect.map((both) => linearFeedCredential(both, rejectedUserToken)),
  );

  // Reconnect with the new credential after a sign-in, key change, or token refresh.
  const credentialChanged = (token: string) =>
    Effect.sleep(CREDENTIAL_RECHECK).pipe(
      Effect.andThen(choose),
      Effect.repeat({ until: (next) => next?.token !== token }),
      Effect.asVoid,
    );

  const connectOnce = Effect.gen(function* () {
    const chosen = yield* choose;
    if (chosen === null) return;
    yield* Stream.runForEach(connect(chosen.token), (event) =>
      event.kind === "connected"
        ? Clock.currentTimeMillis.pipe(
            Effect.tap((now) => Effect.sync(() => (connectedAt = now))),
            Effect.andThen(
              Effect.logDebug("linear live feed connected", { credential: chosen.kind }),
            ),
          )
        : PubSub.publish(changes, event.change),
    ).pipe(
      Effect.raceFirst(credentialChanged(chosen.token)),
      Effect.ensuring(
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            failures =
              connectedAt !== null && now - connectedAt >= STABLE_AFTER_MS ? 0 : failures + 1;
            connectedAt = null;
          }),
        ),
      ),
      Effect.catchTag("LinearLiveFeedClosed", (closed) =>
        Effect.gen(function* () {
          if (rejectsCredential(closed.code) && chosen.kind === "sign-in") {
            rejectedUserToken = chosen.token;
            return yield* Effect.logWarning(
              "linear live feed: Linear rejected the sign-in for live updates; using the API key",
              { code: closed.code, reason: closed.reason },
            );
          }
          yield* Effect.logInfo("linear live feed closed", {
            credential: chosen.kind,
            code: closed.code,
            reason: closed.reason,
            retryInMs: reconnectDelayMs(failures),
          });
        }),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("linear live feed failed", { cause: Cause.pretty(cause) }),
    ),
  );

  return {
    /** Runs forever, reconnecting after drops and when the credential changes. */
    run: connectOnce.pipe(
      Effect.andThen(Effect.suspend(() => Effect.sleep(reconnectDelayMs(failures)))),
      Effect.forever,
    ),
    /** Whether changes are arriving live; while not, readers should poll. */
    live: Clock.currentTimeMillis.pipe(
      Effect.map((now) => connectedAt !== null && now - connectedAt >= LIVE_AFTER_MS),
    ),
    changes: Stream.fromPubSub(changes),
  };
});
