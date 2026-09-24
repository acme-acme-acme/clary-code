import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { RelayLinearAgentSessionProofPayload } from "@t3tools/contracts/relay";
import {
  RELAY_LINEAR_SESSION_REQUEST_TYP,
  RELAY_LINEAR_SESSION_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import {
  handleLinearAgentSessionRequest,
  linearSessionPrompt,
  pickLinearProjectId,
  pickLinearWorktreeBranch,
  resolveLinearWorkspaceStrategy,
} from "./LinearAgentSessionLauncher.ts";

const RELAY_ISSUER = "https://relay.example.test";
const ENVIRONMENT_ID = EnvironmentId.make("env-linear");
const LINKED_USER = "user_linked";

function ed25519() {
  return NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
}

const relayKeys = ed25519();
const environmentKeys = ed25519();

function makeContext() {
  const store = new Map<string, Uint8Array>([
    ["cloud-link-ed25519-key-pair", new TextEncoder().encode(JSON.stringify(environmentKeys))],
  ]);
  const launched: Array<RelayLinearAgentSessionProofPayload> = [];
  const context = {
    secrets: {
      get: (name: string) => Effect.succeed(Option.fromNullishOr(store.get(name))),
      set: (name: string, value: Uint8Array) => Effect.sync(() => void store.set(name, value)),
      create: (name: string, value: Uint8Array) => Effect.sync(() => void store.set(name, value)),
      getOrCreateRandom: (_name: string, bytes: number) => Effect.succeed(new Uint8Array(bytes)),
      remove: (name: string) => Effect.sync(() => void store.delete(name)),
    },
    environment: { getEnvironmentId: Effect.succeed(ENVIRONMENT_ID) },
    cloudMintPublicKey: Effect.succeed(relayKeys.publicKey),
    relayIssuer: Effect.succeed(RELAY_ISSUER),
    linkedCloudUserId: Effect.succeed(LINKED_USER),
    isValidProofWindow: ({ iat, exp }: { iat: number; exp: number }) => exp > iat,
    consumeReplayGuards: (names: ReadonlyArray<string>) =>
      Effect.sync(() => {
        if (names.some((name) => store.has(name))) return false;
        for (const name of names) store.set(name, new Uint8Array());
        return true;
      }),
    launch: (proof: RelayLinearAgentSessionProofPayload) =>
      Effect.sync(() => {
        launched.push(proof);
        return {
          outcome: "launched" as const,
          threadId: ThreadId.make(`linear-session:${proof.agentSessionId}`),
        };
      }),
  };
  return { context, launched };
}

const signProof = (overrides: Partial<RelayLinearAgentSessionProofPayload> = {}) =>
  Effect.gen(function* () {
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const payload = {
      iss: RELAY_ISSUER,
      aud: `t3-env:${ENVIRONMENT_ID}`,
      sub: LINKED_USER,
      jti: NodeCrypto.randomUUID(),
      iat: now,
      exp: now + 120,
      environmentId: ENVIRONMENT_ID,
      nonce: NodeCrypto.randomUUID(),
      scope: ["linear:session"],
      agentSessionId: "session-1",
      issue: {
        id: "issue-uuid",
        identifier: "ENG-7",
        title: "Fix login",
        url: "https://linear.app/acme/issue/ENG-7/fix-login",
        teamKey: "ENG",
      },
      prompt: '<issue identifier="ENG-7">…</issue>',
      creatorName: "Ada",
      ...overrides,
    } satisfies RelayLinearAgentSessionProofPayload;
    const proof = yield* signRelayJwt({
      privateKey: relayKeys.privateKey,
      typ: RELAY_LINEAR_SESSION_REQUEST_TYP,
      payload,
    });
    return { proof, nonce: payload.nonce };
  });

describe("handleLinearAgentSessionRequest", () => {
  // Live clock: the proofs carry real timestamps.
  it.live("launches once for a relay-signed request and signs the outcome back", () =>
    Effect.gen(function* () {
      const { context, launched } = makeContext();
      const { proof, nonce } = yield* signProof();
      const response = yield* handleLinearAgentSessionRequest(context, { proof });
      assert.equal(response.outcome, "launched");
      assert.equal(response.threadId, "linear-session:session-1");
      assert.equal(launched.length, 1);
      assert.equal(launched[0]?.issue.identifier, "ENG-7");

      const signed = yield* verifyRelayJwt({
        publicKey: environmentKeys.publicKey,
        token: response.proof,
        typ: RELAY_LINEAR_SESSION_RESPONSE_TYP,
        issuer: `t3-env:${ENVIRONMENT_ID}`,
        audience: RELAY_ISSUER,
        nowEpochSeconds: Math.floor((yield* DateTime.now).epochMilliseconds / 1_000),
      });
      assert.equal(signed.requestNonce, nonce);
      assert.equal(signed.threadId, response.threadId);

      const replay = yield* handleLinearAgentSessionRequest(context, { proof }).pipe(Effect.flip);
      assert.equal(replay._tag, "EnvironmentHttpConflictError");
      assert.equal(launched.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects requests for another user or scope without launching", () =>
    Effect.gen(function* () {
      const { context, launched } = makeContext();
      for (const overrides of [
        { sub: "someone_else" },
        { scope: ["environment:connect" as never] },
        { aud: "t3-env:another-environment" },
      ]) {
        const { proof } = yield* signProof(overrides);
        const error = yield* handleLinearAgentSessionRequest(context, { proof }).pipe(Effect.flip);
        assert.equal(error._tag, "EnvironmentHttpUnauthorizedError");
      }
      assert.equal(launched.length, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("pickLinearProjectId", () => {
  const linear = {
    defaultProjectId: ProjectId.make("default"),
    teamProjects: [{ teamKey: "ENG", projectId: ProjectId.make("engineering") }],
  };

  it("prefers the team's project, then the default", () => {
    assert.equal(pickLinearProjectId(linear, "eng"), "engineering");
    assert.equal(pickLinearProjectId(linear, "OPS"), "default");
    assert.equal(pickLinearProjectId(linear, null), "default");
    assert.isNull(pickLinearProjectId({ ...linear, defaultProjectId: null }, "OPS"));
  });
});

describe("linearSessionPrompt", () => {
  const issue = {
    id: "issue-uuid",
    identifier: "ENG-7",
    title: "Fix login",
    url: "https://linear.app/acme/issue/ENG-7",
    teamKey: "ENG",
    branchName: "eng-7-fix-login",
  };

  it("fills the environment's template, preferring the worktree's actual branch", () => {
    const prompt = linearSessionPrompt({
      template:
        "Work on {{issue.identifier}}:\nBranch: {{ issue.branchName }}\n\n{{context}}{{unknown}}",
      issue,
      branch: "eng-7-fix-login-2",
      prompt: '<issue identifier="ENG-7"/>',
    });
    assert.equal(
      prompt,
      'Work on ENG-7:\nBranch: eng-7-fix-login-2\n\n<issue identifier="ENG-7"/>{{unknown}}',
    );
  });

  it("uses the default template and falls back when Linear sent no context", () => {
    const prompt = linearSessionPrompt({ template: " ", issue, branch: undefined, prompt: "" });
    assert.include(prompt, "Work on Linear issue ENG-7 (https://linear.app/acme/issue/ENG-7).");
    assert.include(prompt, "\nLinear issue ENG-7.\n");
  });
});

describe("pickLinearWorktreeBranch", () => {
  it("uses Linear's branch, suffixed when a local branch already has it", () => {
    const branch = "ada/eng-7-fix-login";
    assert.equal(pickLinearWorktreeBranch(branch, ["main"]), branch);
    assert.equal(pickLinearWorktreeBranch(branch, ["main", "Ada/ENG-7-fix-login"]), `${branch}-2`);
    assert.equal(
      pickLinearWorktreeBranch(branch, [branch, `${branch}-2`, `${branch}-3`]),
      `${branch}-4`,
    );
  });

  it("leaves naming to the server without a usable suggestion", () => {
    assert.isUndefined(pickLinearWorktreeBranch(undefined, []));
    for (const invalid of ["-eng-7", "eng..7", "eng-7.lock", "eng 7", "eng/", ".eng-7"]) {
      assert.isUndefined(pickLinearWorktreeBranch(invalid, []), invalid);
    }
  });
});

describe("resolveLinearWorkspaceStrategy", () => {
  const gitLayer = (localBranches: ReadonlyArray<string>) =>
    Layer.mock(GitWorkflow.GitWorkflowService)({
      listRefs: () =>
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: localBranches.length,
          refs: localBranches.map((name) => ({
            name,
            current: name === "main",
            isDefault: name === "main",
            worktreePath: null,
          })),
        }),
      listLocalBranchNames: () => Effect.succeed([...localBranches]),
    });

  it.effect("opens the worktree on Linear's branch off the default branch", () =>
    Effect.gen(function* () {
      const strategy = yield* resolveLinearWorkspaceStrategy({
        workspaceRoot: "/repo",
        startFromOrigin: true,
        suggestedBranch: "eng-7-fix-login",
      }).pipe(Effect.provide(gitLayer(["main", "feature/other"])));
      assert.deepStrictEqual(strategy, {
        type: "worktree",
        baseRef: "main",
        startFromOrigin: true,
        branch: "eng-7-fix-login",
      });
    }),
  );

  it.effect("suffixes a branch that already exists, and omits it without a suggestion", () =>
    Effect.gen(function* () {
      const layer = gitLayer(["main", "eng-7-fix-login"]);
      const taken = yield* resolveLinearWorkspaceStrategy({
        workspaceRoot: "/repo",
        startFromOrigin: false,
        suggestedBranch: "eng-7-fix-login",
      }).pipe(Effect.provide(layer));
      assert.equal(taken.type === "worktree" ? taken.branch : null, "eng-7-fix-login-2");

      const unnamed = yield* resolveLinearWorkspaceStrategy({
        workspaceRoot: "/repo",
        startFromOrigin: false,
        suggestedBranch: undefined,
      }).pipe(Effect.provide(layer));
      assert.deepStrictEqual(unnamed, {
        type: "worktree",
        baseRef: "main",
        startFromOrigin: false,
      });
    }),
  );
});
