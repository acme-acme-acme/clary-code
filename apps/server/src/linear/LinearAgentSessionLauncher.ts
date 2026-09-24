import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type LinearSettings,
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

const LINEAR_SESSION_JTI_PREFIX = "cloud-linear-session-jti-";
const LINEAR_SESSION_NONCE_PREFIX = "cloud-linear-session-nonce-";

const decodeProof = Schema.decodeUnknownEffect(RelayLinearAgentSessionProofPayload);

/** What the relay proof checks need from the cloud HTTP layer; see `cloud/http.ts`. */
export interface LinearSessionProofContext<LaunchError, LaunchRequirements> {
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

/** The first message of a delegated thread: Linear's own context, then how to behave. */
export function linearSessionPrompt(input: {
  readonly identifier: string;
  readonly url: string;
  readonly prompt: string;
  readonly creatorName: string | null;
}): string {
  const delegatedBy = input.creatorName ? ` by ${input.creatorName}` : "";
  const context =
    input.prompt.trim().length > 0 ? input.prompt.trim() : `Linear issue ${input.identifier}.`;
  return [
    `Linear issue ${input.identifier} (${input.url}) was delegated to you${delegatedBy}.`,
    "",
    context,
    "",
    "Work on the issue in this thread. Open a pull request when the change is ready.",
  ].join("\n");
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
  };
});

/**
 * Delegated issues always get their own worktree off the default branch, so an
 * agent working unattended never touches the user's checkout.
 */
const resolveWorkspaceStrategy = Effect.fn("LinearAgentSession.resolveWorkspaceStrategy")(
  function* (workspaceRoot: string, startFromOrigin: boolean) {
    const git = yield* GitWorkflow.GitWorkflowService;
    const refs = yield* git
      .listRefs({ cwd: workspaceRoot, refKind: "local", limit: 100 })
      .pipe(Effect.option);
    if (Option.isNone(refs) || !refs.value.isRepo) return { type: "root" as const };
    const base =
      refs.value.refs.find((ref) => ref.isDefault) ?? refs.value.refs.find((ref) => ref.current);
    return base
      ? { type: "worktree" as const, baseRef: base.name, startFromOrigin }
      : { type: "root" as const };
  },
);

export const launchLinearAgentSession = Effect.fn("LinearAgentSession.launch")(function* (
  proof: RelayLinearAgentSessionProofPayload,
) {
  const target = yield* resolveLaunchTarget(proof.issue.teamKey);
  if (target === null) return { outcome: "no_project" as const, threadId: null };
  // Keyed by the Linear session, so a relay retry lands on the same thread.
  const commandId = CommandId.make(`linear-session:${proof.agentSessionId}`);
  const threadId = ThreadId.make(`linear-session:${proof.agentSessionId}`);
  const result = yield* ThreadMessageIntake.launchThread({
    commandId,
    threadId,
    projectId: target.project.id,
    title: `${proof.issue.identifier} ${proof.issue.title}`.slice(0, 120),
    modelSelection: target.modelSelection,
    runtimeMode: target.runtimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    workspaceStrategy: yield* resolveWorkspaceStrategy(
      target.project.workspaceRoot,
      target.startFromOrigin,
    ),
    initialMessage: {
      messageId: MessageId.make(`linear-session:${proof.agentSessionId}`),
      text: linearSessionPrompt({
        identifier: proof.issue.identifier,
        url: proof.issue.url,
        prompt: proof.prompt,
        creatorName: proof.creatorName,
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
 * request. Same trust checks as the mint and health handlers: the proof must
 * be relay-signed, addressed to this environment and its linked user, short
 * lived, single-use, and the response is signed back bound to the nonce.
 */
export const handleLinearAgentSessionRequest = Effect.fn("environment.cloud.linearAgentSession")(
  function* <LaunchError, LaunchRequirements>(
    context: LinearSessionProofContext<LaunchError, LaunchRequirements>,
    request: RelayLinearAgentSessionRequest,
  ) {
    const cloudMintPublicKey = yield* context.cloudMintPublicKey;
    const relayIssuer = yield* context.relayIssuer;
    const environmentId = yield* context.environment.getEnvironmentId;
    const linkedCloudUserId = yield* context.linkedCloudUserId;
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_LINEAR_SESSION_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `t3-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.sub !== linkedCloudUserId ||
      !context.isValidProofWindow({ ...proofOption.value, nowSeconds }) ||
      proofOption.value.scope.length !== 1 ||
      proofOption.value.scope[0] !== "linear:session"
    ) {
      return yield* new EnvironmentHttpUnauthorizedError({
        message: "Invalid Linear session request.",
      });
    }
    const proof = proofOption.value;
    const consumed = yield* context.consumeReplayGuards(
      [`${LINEAR_SESSION_JTI_PREFIX}${proof.jti}`, `${LINEAR_SESSION_NONCE_PREFIX}${proof.nonce}`],
      new TextEncoder().encode(DateTime.formatIso(now)),
    );
    if (!consumed) {
      return yield* new EnvironmentHttpConflictError({
        message: "Linear session request was already consumed.",
      });
    }

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
