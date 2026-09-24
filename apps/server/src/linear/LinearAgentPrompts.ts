import { CommandId, MessageId } from "@t3tools/contracts";
import {
  RelayLinearAgentPromptProofPayload,
  type RelayLinearAgentPromptOutcome,
  type RelayLinearAgentPromptRequest,
  type RelayLinearAgentPromptResponse,
} from "@t3tools/contracts/relay";
import { RELAY_LINEAR_PROMPT_REQUEST_TYP } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  type LinearRelayProofChecks,
  linearSessionThreadId,
  verifyLinearRelayRequest,
} from "./LinearAgentSessionLauncher.ts";

const LINEAR_PROMPT_REPLAY_PREFIX = "cloud-linear-prompt-";
const decodeProof = Schema.decodeUnknownEffect(RelayLinearAgentPromptProofPayload);

/** Messages Linear sent, so the mirror doesn't echo them back into Linear. */
export const LINEAR_PROMPT_MESSAGE_PREFIX = "linear-prompt:";

/**
 * Delivers a reply sent in Linear to the session's thread, steering the
 * running turn or starting a new one, or interrupts the thread on a stop.
 */
export const deliverLinearAgentPrompt = Effect.fn("LinearAgentPrompt.deliver")(function* (
  proof: RelayLinearAgentPromptProofPayload,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadId = linearSessionThreadId(proof.agentSessionId);
  const thread = yield* threads.getThreadShell(threadId);
  if (thread === null) return "thread_missing" as const;
  if (proof.kind === "stop") {
    const interrupted = yield* threads.interruptThread({
      projectId: thread.projectId,
      commandId: CommandId.make(`linear-stop:${proof.activityId}`),
      threadId,
      reason: "Stopped from Linear.",
    });
    return interrupted.type === "interrupt_requested"
      ? ("delivered" as const)
      : ("not_running" as const);
  }
  // Linear replies carry no attachments, so this skips the intake that claims uploads.
  yield* threads.sendToThread({
    projectId: thread.projectId,
    commandId: CommandId.make(`${LINEAR_PROMPT_MESSAGE_PREFIX}${proof.activityId}`),
    threadId,
    messageId: MessageId.make(`${LINEAR_PROMPT_MESSAGE_PREFIX}${proof.activityId}`),
    text: proof.body,
    attachments: [],
    mode: "auto",
    createdBy: "user",
    creationSource: "server",
  });
  return "delivered" as const;
});

export interface LinearPromptProofContext<
  DeliverError,
  DeliverRequirements,
> extends LinearRelayProofChecks {
  /** `deliverLinearAgentPrompt` in production. */
  readonly deliver: (
    proof: RelayLinearAgentPromptProofPayload,
  ) => Effect.Effect<RelayLinearAgentPromptOutcome, DeliverError, DeliverRequirements>;
}

/** Handles the relay's signed "someone replied or pressed stop in Linear" request. */
export const handleLinearAgentPromptRequest = Effect.fn("environment.cloud.linearAgentPrompt")(
  function* <DeliverError, DeliverRequirements>(
    context: LinearPromptProofContext<DeliverError, DeliverRequirements>,
    request: RelayLinearAgentPromptRequest,
  ) {
    const { proof } = yield* verifyLinearRelayRequest(context, {
      token: request.proof,
      typ: RELAY_LINEAR_PROMPT_REQUEST_TYP,
      scope: "linear:prompt",
      replayPrefix: LINEAR_PROMPT_REPLAY_PREFIX,
      decode: decodeProof,
    });
    const outcome = yield* context.deliver(proof);
    return { outcome } satisfies RelayLinearAgentPromptResponse;
  },
);
