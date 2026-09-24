import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type LinearSettings,
  renderLinearPromptTemplate,
  type ProjectId,
  EnvironmentHttpConflictError,
  EnvironmentHttpUnauthorizedError,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import {
  RelayLinearAgentSessionProofPayload,
  type RelayLinearAgentSessionOutcome,
  type RelayLinearAgentSessionRequest,
  type RelayLinearAgentSessionResponse,
  type RelayLinearAgentSessionResponseProofPayload,
} from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_LINEAR_SESSION_REQUEST_TYP,
  RELAY_LINEAR_SESSION_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import type * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { getAutoBootstrapThreadModelSelection } from "../serverRuntimeStartup.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const LINEAR_SESSION_REPLAY_PREFIX = "cloud-linear-session-";

const decodeProof = Schema.decodeUnknownEffect(RelayLinearAgentSessionProofPayload);

/** What the relay proof checks need from the cloud HTTP layer; see `cloud/http.ts`. */
export interface LinearRelayProofChecks {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly environment: Pick<ServerEnvironment.ServerEnvironment["Service"], "getEnvironmentId">;
  readonly cloudMintPublicKey: Effect.Effect<string, EnvironmentAuth.ServerAuthInternalError>;
  readonly relayIssuer: Effect.Effect<string, EnvironmentAuth.ServerAuthInternalError>;
  readonly linkedCloudUserId: Effect.Effect<string, EnvironmentAuth.ServerAuthInternalError>;
  readonly isValidProofWindow: (input: {
    readonly iat: number;
    readonly exp: number;
    readonly nowSeconds: number;
  }) => boolean;
  readonly consumeReplayGuards: (
    names: ReadonlyArray<string>,
    value: Uint8Array,
  ) => Effect.Effect<boolean, ServerSecretStore.SecretStoreError>;
}

export interface LinearSessionProofContext<
  LaunchError,
  LaunchRequirements,
> extends LinearRelayProofChecks {
  /** Starts the thread once the request is verified; `launchLinearAgentSession` in production. */
  readonly launch: (proof: RelayLinearAgentSessionProofPayload) => Effect.Effect<
    {
      readonly outcome: RelayLinearAgentSessionOutcome;
      readonly threadId: ThreadId | null;
    },
    LaunchError,
    LaunchRequirements
  >;
}

/**
 * Checks a relay-signed Linear request the same way as the mint and health
 * handlers: relay-signed, addressed to this environment and its linked user,
 * short lived, carrying exactly the expected scope, and single-use.
 */
export const verifyLinearRelayRequest = Effect.fn("LinearRelayRequest.verify")(function* <
  A extends {
    readonly environmentId: string;
    readonly sub: string;
    readonly iat: number;
    readonly exp: number;
    readonly jti: string;
    readonly nonce: string;
    readonly scope: ReadonlyArray<string>;
  },
  DecodeError,
>(
  checks: LinearRelayProofChecks,
  input: {
    readonly token: string;
    readonly typ: string;
    readonly scope: string;
    /** Names this request kind's replay guards, e.g. `cloud-linear-session-`. */
    readonly replayPrefix: string;
    readonly decode: (payload: unknown) => Effect.Effect<A, DecodeError>;
  },
) {
  const cloudMintPublicKey = yield* checks.cloudMintPublicKey;
  const relayIssuer = yield* checks.relayIssuer;
  const environmentId = yield* checks.environment.getEnvironmentId;
  const linkedCloudUserId = yield* checks.linkedCloudUserId;
  const now = yield* DateTime.now;
  const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
  const proofOption = yield* verifyRelayJwt({
    publicKey: cloudMintPublicKey,
    token: input.token,
    typ: input.typ,
    issuer: normalizeRelayIssuer(relayIssuer),
    audience: `t3-env:${environmentId}`,
    nowEpochSeconds: nowSeconds,
  }).pipe(Effect.flatMap(input.decode), Effect.option);
  if (
    Option.isNone(proofOption) ||
    proofOption.value.environmentId !== environmentId ||
    proofOption.value.sub !== linkedCloudUserId ||
    !checks.isValidProofWindow({ ...proofOption.value, nowSeconds }) ||
    proofOption.value.scope.length !== 1 ||
    proofOption.value.scope[0] !== input.scope
  ) {
    return yield* new EnvironmentHttpUnauthorizedError({
      message: "Invalid Linear request.",
    });
  }
  const proof = proofOption.value;
  const consumed = yield* checks.consumeReplayGuards(
    [`${input.replayPrefix}jti-${proof.jti}`, `${input.replayPrefix}nonce-${proof.nonce}`],
    new TextEncoder().encode(DateTime.formatIso(now)),
  );
  if (!consumed) {
    return yield* new EnvironmentHttpConflictError({
      message: "Linear request was already consumed.",
    });
  }
  return { proof, environmentId, relayIssuer, nowSeconds };
});

const LINEAR_SESSION_THREAD_PREFIX = "linear-session:";

/** The thread a delegated Linear session runs in, keyed by the session so retries land on it. */
export const linearSessionThreadId = (agentSessionId: string) =>
  ThreadId.make(`${LINEAR_SESSION_THREAD_PREFIX}${agentSessionId}`);

/** The Linear session a thread was delegated from, or null for any other thread. */
export const linearAgentSessionIdOf = (threadId: string): string | null =>
  threadId.startsWith(LINEAR_SESSION_THREAD_PREFIX)
    ? threadId.slice(LINEAR_SESSION_THREAD_PREFIX.length) || null
    : null;

/** The first message of a delegated thread, from the environment's Linear prompt template. */
export function linearSessionPrompt(input: {
  readonly template: string;
  readonly issue: RelayLinearAgentSessionProofPayload["issue"];
  readonly branch: string | undefined;
  readonly prompt: string;
}): string {
  const context = input.prompt.trim();
  return renderLinearPromptTemplate(input.template, {
    "issue.identifier": input.issue.identifier,
    "issue.title": input.issue.title,
    "issue.url": input.issue.url,
    "issue.branchName": input.branch ?? input.issue.branchName ?? "",
    context: context.length > 0 ? context : `Linear issue ${input.issue.identifier}.`,
  });
}

/** The project a delegated issue runs in: the team's mapping, else the default. */
export function pickLinearProjectId(
  linear: Pick<LinearSettings, "defaultProjectId" | "teamProjects">,
  teamKey: string | null,
): ProjectId | null {
  const mapped = teamKey
    ? linear.teamProjects.find((entry) => entry.teamKey.toUpperCase() === teamKey.toUpperCase())
    : undefined;
  return mapped?.projectId ?? linear.defaultProjectId;
}

/** Git's ref-name rules, for the branch names Linear suggests; anything odd is left to the server's naming. */
function isUsableBranchName(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/u.test(name) && !/(^|\/)[.-]|\.\.|\/\/|[/.]$|\.lock(\/|$)/u.test(name);
}

/**
 * The worktree branch for a delegated issue: Linear's suggested name, suffixed
 * when a local branch already has it (say, the issue was delegated before).
 * `undefined` lets the server pick a temporary name and rename it later.
 */
export function pickLinearWorktreeBranch(
  suggested: string | undefined,
  existingBranchNames: ReadonlyArray<string>,
): string | undefined {
  if (suggested === undefined || !isUsableBranchName(suggested)) return undefined;
  const existing = new Set(existingBranchNames.map((name) => name.toLowerCase()));
  if (!existing.has(suggested.toLowerCase())) return suggested;
  let suffix = 2;
  while (existing.has(`${suggested}-${suffix}`.toLowerCase())) suffix += 1;
  return `${suggested}-${suffix}`;
}

const resolveLaunchTarget = Effect.fn("LinearAgentSession.resolveLaunchTarget")(function* (
  teamKey: string | null,
) {
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const projects = yield* ProjectService.ProjectService;
  const projectId = pickLinearProjectId(settings.linear, teamKey);
  if (projectId === null) return null;
  const project = yield* projects.getById(projectId).pipe(Effect.map(Option.getOrNull));
  if (project === null || project.deletedAt !== null) return null;
  const resolved = resolveProjectSettings(settings, project.id, project).settings;
  return {
    project,
    modelSelection: resolved.defaultModelSelection ?? getAutoBootstrapThreadModelSelection(),
    runtimeMode: resolved.defaultRuntimeMode,
    startFromOrigin: settings.newWorktreesStartFromOrigin,
    promptTemplate: settings.linear.promptTemplate,
  };
});

/**
 * Delegated issues always get their own worktree off the default branch, so an
 * agent working unattended never touches the user's checkout. The branch is
 * Linear's suggested name when the relay sent one.
 */
export const resolveLinearWorkspaceStrategy = Effect.fn(
  "LinearAgentSession.resolveWorkspaceStrategy",
)(function* (input: {
  readonly workspaceRoot: string;
  readonly startFromOrigin: boolean;
  readonly suggestedBranch: string | undefined;
}) {
  const git = yield* GitWorkflow.GitWorkflowService;
  const refs = yield* git
    .listRefs({ cwd: input.workspaceRoot, refKind: "local", limit: 100 })
    .pipe(Effect.option);
  if (Option.isNone(refs) || !refs.value.isRepo) return { type: "root" as const };
  const base =
    refs.value.refs.find((ref) => ref.isDefault) ?? refs.value.refs.find((ref) => ref.current);
  if (!base) return { type: "root" as const };
  // Unknown local branches would risk a failing `git worktree add`; fall back to the server's naming.
  const branch =
    input.suggestedBranch === undefined
      ? undefined
      : yield* git.listLocalBranchNames(input.workspaceRoot).pipe(
          Effect.map((names) => pickLinearWorktreeBranch(input.suggestedBranch, names)),
          Effect.orElseSucceed(() => undefined),
        );
  return {
    type: "worktree" as const,
    baseRef: base.name,
    startFromOrigin: input.startFromOrigin,
    ...(branch ? { branch } : {}),
  };
});

export const launchLinearAgentSession = Effect.fn("LinearAgentSession.launch")(function* (
  proof: RelayLinearAgentSessionProofPayload,
) {
  const target = yield* resolveLaunchTarget(proof.issue.teamKey);
  if (target === null) return { outcome: "no_project" as const, threadId: null };
  // Keyed by the Linear session, so a relay retry lands on the same thread.
  const commandId = CommandId.make(`linear-session:${proof.agentSessionId}`);
  const threadId = linearSessionThreadId(proof.agentSessionId);
  const workspaceStrategy = yield* resolveLinearWorkspaceStrategy({
    workspaceRoot: target.project.workspaceRoot,
    startFromOrigin: target.startFromOrigin,
    suggestedBranch: proof.issue.branchName,
  });
  const result = yield* ThreadMessageIntake.launchThread({
    commandId,
    threadId,
    projectId: target.project.id,
    title: `${proof.issue.identifier} ${proof.issue.title}`.slice(0, 120),
    modelSelection: target.modelSelection,
    runtimeMode: target.runtimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    workspaceStrategy,
    initialMessage: {
      messageId: MessageId.make(`linear-session:${proof.agentSessionId}`),
      text: linearSessionPrompt({
        template: target.promptTemplate,
        issue: proof.issue,
        branch: workspaceStrategy.type === "worktree" ? workspaceStrategy.branch : undefined,
        prompt: proof.prompt,
      }),
      attachments: [],
    },
    createdBy: "user",
    creationSource: "server",
  });
  const orchestrator = yield* OrchestratorV2;
  yield* orchestrator
    .dispatch({
      type: "thread.linear-issue.link",
      commandId: CommandId.make(`linear-session-link:${proof.agentSessionId}`),
      threadId: result.threadId,
      identifier: proof.issue.identifier,
      url: proof.issue.url,
      source: "delegated",
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not link the delegated Linear issue", { cause }),
      ),
    );
  return { outcome: "launched" as const, threadId: result.threadId };
});

/**
 * Handles the relay's signed "start a thread for this delegated issue"
 * request. The response is signed back bound to the request nonce.
 */
export const handleLinearAgentSessionRequest = Effect.fn("environment.cloud.linearAgentSession")(
  function* <LaunchError, LaunchRequirements>(
    context: LinearSessionProofContext<LaunchError, LaunchRequirements>,
    request: RelayLinearAgentSessionRequest,
  ) {
    const { proof, environmentId, relayIssuer, nowSeconds } = yield* verifyLinearRelayRequest(
      context,
      {
        token: request.proof,
        typ: RELAY_LINEAR_SESSION_REQUEST_TYP,
        scope: "linear:session",
        replayPrefix: LINEAR_SESSION_REPLAY_PREFIX,
        decode: decodeProof,
      },
    );

    const launched: {
      readonly outcome: RelayLinearAgentSessionOutcome;
      readonly threadId: ThreadId | null;
    } = yield* context.launch(proof);

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(context.secrets);
    const responsePayload = {
      iss: `t3-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: nowSeconds + 5 * 60,
      environmentId,
      requestNonce: proof.nonce,
      outcome: launched.outcome,
      threadId: launched.threadId,
    } satisfies RelayLinearAgentSessionResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_LINEAR_SESSION_RESPONSE_TYP,
      payload: responsePayload,
    });
    return {
      outcome: launched.outcome,
      threadId: launched.threadId,
      proof: responseProof,
    } satisfies RelayLinearAgentSessionResponse;
  },
);
