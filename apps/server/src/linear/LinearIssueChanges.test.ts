import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type LinearIssueChange } from "@t3tools/contracts";
import type { RelayLinearIssueChangesProofPayload } from "@t3tools/contracts/relay";
import {
  RELAY_LINEAR_CHANGES_REQUEST_TYP,
  RELAY_LINEAR_PROMPT_REQUEST_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { handleLinearIssueChangesRequest } from "./LinearIssueChanges.ts";

const RELAY_ISSUER = "https://relay.example.test";
const ENVIRONMENT_ID = EnvironmentId.make("env-linear");
const LINKED_USER = "user_linked";

const relayKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

function makeContext() {
  const delivered: Array<ReadonlyArray<LinearIssueChange>> = [];
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
    consumeReplayGuards: () => Effect.succeed(true),
    deliver: (changes: ReadonlyArray<LinearIssueChange>) =>
      Effect.sync(() => void delivered.push(changes)),
  };
  return { context, delivered };
}

const signChanges = (
  overrides: Partial<RelayLinearIssueChangesProofPayload> = {},
  typ = RELAY_LINEAR_CHANGES_REQUEST_TYP,
) =>
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
        scope: ["linear:changes"],
        changes: [{ issueId: "issue-1", identifier: "ENG-1" }],
        ...overrides,
      } satisfies RelayLinearIssueChangesProofPayload,
    });
  });

describe("handleLinearIssueChangesRequest", () => {
  // Live clock: the proofs carry real timestamps.
  it.live("hands relay-signed issue changes to the sync", () =>
    Effect.gen(function* () {
      const { context, delivered } = makeContext();
      const proof = yield* signChanges();
      assert.deepEqual(yield* handleLinearIssueChangesRequest(context, { proof }), { ok: true });
      assert.deepEqual(delivered, [[{ issueId: "issue-1", identifier: "ENG-1" }]]);
    }),
  );

  it.live("rejects another user's, another kind's, or another scope's request", () =>
    Effect.gen(function* () {
      const { context, delivered } = makeContext();
      for (const proof of [
        yield* signChanges({ sub: "someone_else" }),
        yield* signChanges({ scope: ["linear:prompt" as never] }),
        yield* signChanges({}, RELAY_LINEAR_PROMPT_REQUEST_TYP),
      ]) {
        const error = yield* handleLinearIssueChangesRequest(context, { proof }).pipe(Effect.flip);
        assert.equal(error._tag, "EnvironmentHttpUnauthorizedError");
      }
      assert.equal(delivered.length, 0);
    }),
  );
});
