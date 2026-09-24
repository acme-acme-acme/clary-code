import type { LinearIssueChange } from "@t3tools/contracts";
import {
  RelayLinearIssueChangesProofPayload,
  type RelayLinearIssueChangesRequest,
} from "@t3tools/contracts/relay";
import { RELAY_LINEAR_CHANGES_REQUEST_TYP } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type LinearRelayProofChecks,
  verifyLinearRelayRequest,
} from "./LinearAgentSessionLauncher.ts";

const LINEAR_CHANGES_REPLAY_PREFIX = "cloud-linear-changes-";
const decodeProof = Schema.decodeUnknownEffect(RelayLinearIssueChangesProofPayload);

export interface LinearIssueChangesProofContext<
  DeliverError,
  DeliverRequirements,
> extends LinearRelayProofChecks {
  /** `LinearIssueSyncReactor.publishIssueChanges` in production. */
  readonly deliver: (
    changes: ReadonlyArray<LinearIssueChange>,
  ) => Effect.Effect<void, DeliverError, DeliverRequirements>;
}

/**
 * Handles the relay's signed "these issues changed in Linear" request, sent
 * from the Otter app's webhook, so linked issues refresh without waiting for
 * the next poll.
 */
export const handleLinearIssueChangesRequest = Effect.fn("environment.cloud.linearIssueChanges")(
  function* <DeliverError, DeliverRequirements>(
    context: LinearIssueChangesProofContext<DeliverError, DeliverRequirements>,
    request: RelayLinearIssueChangesRequest,
  ) {
    const { proof } = yield* verifyLinearRelayRequest(context, {
      token: request.proof,
      typ: RELAY_LINEAR_CHANGES_REQUEST_TYP,
      scope: "linear:changes",
      replayPrefix: LINEAR_CHANGES_REPLAY_PREFIX,
      decode: decodeProof,
    });
    yield* context.deliver(proof.changes);
    return { ok: true };
  },
);
