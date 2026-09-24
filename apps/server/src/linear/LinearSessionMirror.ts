import type { ThreadId } from "@t3tools/contracts";
import { RelayApi, type RelayLinearActivity } from "@t3tools/contracts/relay";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { linearAgentSessionIdOf } from "./LinearAgentSessionLauncher.ts";
import { LinearSessionActivityMirror } from "./linearSessionActivities.ts";

/** The relay accepts this many activities per request. */
const ACTIVITIES_PER_REQUEST = 20;

interface PendingActivities {
  readonly threadId: ThreadId;
  readonly agentSessionId: string;
  readonly activities: ReadonlyArray<RelayLinearActivity>;
}

/**
 * Mirrors threads started from a Linear agent session back into that
 * session, through the relay that holds the workspace's Linear token.
 * Live only: steps that happen while the server is down aren't replayed.
 */
export class LinearSessionMirror extends Context.Service<
  LinearSessionMirror,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/linear/LinearSessionMirror") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestratorV2;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const mirrors = new Map<ThreadId, LinearSessionActivityMirror>();

  const readSecretString = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map((bytes) =>
          Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
        ),
      );

  const post = Effect.fn("LinearSessionMirror.post")(function* (pending: PendingActivities) {
    const [url, environmentCredential] = yield* Effect.all([
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    if (!url || !environmentCredential) {
      return yield* Effect.logDebug("linear activity skipped; not linked to a relay");
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const relay = yield* HttpApiClient.make(RelayApi, {
      baseUrl: url,
      transformClient: HttpClient.mapRequest(
        HttpClientRequest.setHeader("authorization", `Bearer ${environmentCredential}`),
      ),
    }).pipe(Effect.provide(FetchHttpClient.layer));
    for (let start = 0; start < pending.activities.length; start += ACTIVITIES_PER_REQUEST) {
      yield* relay.linearServer.postLinearActivities({
        params: { environmentId, agentSessionId: pending.agentSessionId },
        payload: {
          threadId: pending.threadId,
          activities: pending.activities.slice(start, start + ACTIVITIES_PER_REQUEST),
        },
      });
    }
  });

  // One queue, so a session's activities reach Linear in the order they happened.
  const worker = yield* makeDrainableWorker((pending: PendingActivities) =>
    post(pending).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("linear activity mirror failed", {
          threadId: pending.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );

  const start: LinearSessionMirror["Service"]["start"] = Effect.fn("LinearSessionMirror.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          const agentSessionId = linearAgentSessionIdOf(event.threadId);
          if (agentSessionId === null) return Effect.void;
          if (event.type === "thread.deleted") {
            mirrors.delete(event.threadId);
            return Effect.void;
          }
          let mirror = mirrors.get(event.threadId);
          if (mirror === undefined) {
            mirror = new LinearSessionActivityMirror();
            mirrors.set(event.threadId, mirror);
          }
          const activities = mirror.apply(event);
          return activities.length === 0
            ? Effect.void
            : worker
                .enqueue({ threadId: event.threadId, agentSessionId, activities })
                .pipe(Effect.asVoid);
        }),
      );
    },
  );

  return { start, drain: worker.drain } satisfies LinearSessionMirror["Service"];
});

export const layer = Layer.effect(LinearSessionMirror, make);
