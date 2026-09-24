import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { RelayLinearAgentPromptProofPayload } from "@t3tools/contracts/relay";
import {
  RELAY_LINEAR_PROMPT_REQUEST_TYP,
  RELAY_LINEAR_SESSION_REQUEST_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { deliverLinearAgentPrompt, handleLinearAgentPromptRequest } from "./LinearAgentPrompts.ts";

const RELAY_ISSUER = "https://relay.example.test";
const ENVIRONMENT_ID = EnvironmentId.make("env-linear");
const LINKED_USER = "user_linked";

const relayKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

function makeContext() {
  const guards = new Set<string>();
  const delivered: Array<RelayLinearAgentPromptProofPayload> = [];
  const context = {
    secrets: {
      get: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: (_name: string, bytes: number) => Effect.succeed(new Uint8Array(bytes)),
      remove: () => Effect.void,
    },
    environment: { getEnvironmentId: Effect.succeed(ENVIRONMENT_ID) },
    cloudMintPublicKey: Effect.succeed(relayKeys.publicKey),
    relayIssuer: Effect.succeed(RELAY_ISSUER),
    linkedCloudUserId: Effect.succeed(LINKED_USER),
    isValidProofWindow: ({ iat, exp }: { iat: number; exp: number }) => exp > iat,
    consumeReplayGuards: (names: ReadonlyArray<string>) =>
      Effect.sync(() => {
        if (names.some((name) => guards.has(name))) return false;
        for (const name of names) guards.add(name);
        return true;
      }),
    deliver: (proof: RelayLinearAgentPromptProofPayload) =>
      Effect.sync(() => {
        delivered.push(proof);
        return "delivered" as const;
      }),
  };
  return { context, delivered };
}

const signPrompt = (typ = RELAY_LINEAR_PROMPT_REQUEST_TYP) =>
  Effect.gen(function* () {
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    return yield* signRelayJwt({
      privateKey: relayKeys.privateKey,
      typ,
      payload: {
        iss: RELAY_ISSUER,
        aud: `t3-env:${ENVIRONMENT_ID}`,
        sub: LINKED_USER,
        jti: NodeCrypto.randomUUID(),
        iat: now,
        exp: now + 120,
        environmentId: ENVIRONMENT_ID,
        nonce: NodeCrypto.randomUUID(),
        scope: ["linear:prompt"],
        agentSessionId: "session-1",
        activityId: "activity-1",
        kind: "message",
        body: "Also add a test",
      } satisfies RelayLinearAgentPromptProofPayload,
    });
  });

describe("handleLinearAgentPromptRequest", () => {
  // Live clock: the proofs carry real timestamps.
  it.live("delivers a relay-signed reply once", () =>
    Effect.gen(function* () {
      const { context, delivered } = makeContext();
      const proof = yield* signPrompt();
      const response = yield* handleLinearAgentPromptRequest(context, { proof });
      assert.equal(response.outcome, "delivered");
      assert.equal(delivered[0]?.body, "Also add a test");

      const replay = yield* handleLinearAgentPromptRequest(context, { proof }).pipe(Effect.flip);
      assert.equal(replay._tag, "EnvironmentHttpConflictError");
      assert.equal(delivered.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a proof signed for another request kind", () =>
    Effect.gen(function* () {
      const { context, delivered } = makeContext();
      const proof = yield* signPrompt(RELAY_LINEAR_SESSION_REQUEST_TYP);
      const error = yield* handleLinearAgentPromptRequest(context, { proof }).pipe(Effect.flip);
      assert.equal(error._tag, "EnvironmentHttpUnauthorizedError");
      assert.equal(delivered.length, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("deliverLinearAgentPrompt", () => {
  const stop = {
    agentSessionId: "session-1",
    activityId: "activity-2",
    kind: "stop",
    body: "",
  } as RelayLinearAgentPromptProofPayload;

  const threadsLayer = (options: {
    readonly exists: boolean;
    readonly interrupted: ThreadManagement.ThreadManagementInterruptResult["type"];
  }) => {
    const interrupts: Array<ThreadManagement.ThreadManagementInterruptInput> = [];
    const layer = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed(
          options.exists ? ({ projectId: ProjectId.make("project-1") } as never) : null,
        ),
      interruptThread: (input) =>
        Effect.sync(() => {
          interrupts.push(input);
          return { type: options.interrupted } as never;
        }),
    });
    return { layer, interrupts };
  };

  it.effect("interrupts the session's thread on a stop", () =>
    Effect.gen(function* () {
      const running = threadsLayer({ exists: true, interrupted: "interrupt_requested" });
      assert.equal(
        yield* deliverLinearAgentPrompt(stop).pipe(Effect.provide(running.layer)),
        "delivered",
      );
      assert.equal(running.interrupts[0]?.threadId, "linear-session:session-1");

      const idle = threadsLayer({ exists: true, interrupted: "no_active_run" });
      assert.equal(
        yield* deliverLinearAgentPrompt(stop).pipe(Effect.provide(idle.layer)),
        "not_running",
      );

      const deleted = threadsLayer({ exists: false, interrupted: "no_active_run" });
      assert.equal(
        yield* deliverLinearAgentPrompt(stop).pipe(Effect.provide(deleted.layer)),
        "thread_missing",
      );
    }),
  );
});
