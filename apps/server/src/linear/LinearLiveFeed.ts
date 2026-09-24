import type { LinearIssueChange } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const LINEAR_REALTIME_URL = "wss://api.linear.app/graphql";
const RECONNECT_DELAY = "10 seconds";
const CREDENTIAL_RECHECK = "1 minute";

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

/**
 * One live connection to Linear's subscription endpoint (graphql-transport-ws).
 * Linear authenticates subscriptions only through the handshake's
 * Authorization header, which Node's WebSocket accepts as `headers`.
 */
const connect = (token: string) =>
  Stream.callback<LinearIssueChange>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const init = {
          protocols: ["graphql-transport-ws"],
          headers: { Authorization: token.startsWith("lin_oauth_") ? `Bearer ${token}` : token },
        };
        const socket = new WebSocket(LINEAR_REALTIME_URL, init as unknown as string[]);
        const send = (message: unknown) => socket.send(encodeMessage(message));
        socket.addEventListener("open", () => send({ type: "connection_init", payload: {} }));
        socket.addEventListener("message", (event) => {
          const raw = String(event.data);
          const type = Option.getOrNull(decodeMessage(raw))?.type;
          if (type === "connection_ack") {
            SUBSCRIPTIONS.forEach((query, index) =>
              send({ id: String(index + 1), type: "subscribe", payload: { query } }),
            );
          } else if (type === "ping") {
            send({ type: "pong" });
          } else if (type === "error") {
            // A rejected subscription (say, a revoked key) would otherwise idle forever.
            socket.close();
          } else {
            const change = issueChangeFromMessage(raw);
            if (change) Queue.offerUnsafe(queue, change);
          }
        });
        socket.addEventListener("close", () => Queue.endUnsafe(queue));
        socket.addEventListener("error", () => Queue.endUnsafe(queue));
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    ),
  );

/**
 * Issue changes from Linear as they happen, while this environment can read
 * Linear. Undocumented by Linear, so everything that reads issues keeps
 * polling as a fallback; the feed only makes updates arrive sooner.
 */
export const makeLinearLiveFeed = Effect.fn("LinearLiveFeed.make")(function* (
  /** The token to connect with, from `makeLinearCredentials`; null when there is none. */
  currentToken: Effect.Effect<string | null>,
) {
  const changes = yield* PubSub.unbounded<LinearIssueChange>();

  // Reconnect with the new credential after a sign-in, key change, or token refresh.
  const tokenChanged = (token: string) =>
    Effect.sleep(CREDENTIAL_RECHECK).pipe(
      Effect.andThen(currentToken),
      Effect.repeat({ until: (next) => next !== token }),
      Effect.asVoid,
    );

  const connectOnce = Effect.gen(function* () {
    const token = yield* currentToken;
    if (token === null) return;
    yield* Stream.runForEach(connect(token), (change) => PubSub.publish(changes, change)).pipe(
      Effect.raceFirst(tokenChanged(token)),
    );
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("linear live feed disconnected", { cause: Cause.pretty(cause) }),
    ),
  );

  return {
    /** Runs forever, reconnecting after drops and when the credential changes. */
    run: connectOnce.pipe(Effect.andThen(Effect.sleep(RECONNECT_DELAY)), Effect.forever),
    changes: Stream.fromPubSub(changes),
  };
});
