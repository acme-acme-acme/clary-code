import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * The Linear issue page. It re-reads when `linearIssueChanges` reports the
 * issue changed; the interval is the fallback for when Linear's feed is down.
 */
export const linearIssueDetail = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:linear:issue-detail",
  tag: WS_METHODS.linearIssueDetail,
  staleTimeMs: 10_000,
  refreshIntervalMs: 30_000,
  idleTtlMs: 60_000,
});

/** The latest issue Linear reported changing, pushed by the environment's live feed. */
export const linearIssueChanges = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:linear:issue-changes",
    tag: WS_METHODS.linearSubscribeIssueChanges,
  },
);

/** One read of an issue, for actions that need it once, like opening its review. */
export const readLinearIssueDetail = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:linear:read-issue-detail",
  tag: WS_METHODS.linearIssueDetail,
});
