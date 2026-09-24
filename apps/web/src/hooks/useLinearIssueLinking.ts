import { useMemo } from "react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useServerConfigs } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

/** Link and unlink Linear issues on threads of environments that advertise `threadLinearIssues`. */
export function useLinearIssueLinking(environmentId: EnvironmentId | null | undefined) {
  const configs = useServerConfigs();
  const supported =
    environmentId != null &&
    configs.get(environmentId)?.environment.capabilities.threadLinearIssues === true;
  const link = useAtomCommand(threadEnvironment.linkLinearIssue, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkLinearIssue, { reportFailure: true });
  return useMemo(() => {
    /** Rejects with a readable error so the link dialog can show it inline. */
    const linkIssue = async (
      threadRef: ScopedThreadRef,
      issue: { readonly identifier: string; readonly url: string },
    ) => {
      if (!supported || threadRef.environmentId !== environmentId)
        throw new Error("This environment does not support linking Linear issues.");
      const result = await link({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, ...issue, source: "manual" },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) throw new Error("Link update interrupted.");
        throw squashAtomCommandFailure(result);
      }
    };
    /** Failures surface through the command's own failure toast. */
    const unlinkIssue = (threadRef: ScopedThreadRef, identifier: string) => {
      void unlink({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, identifier },
      });
    };
    return { supported, linkIssue, unlinkIssue };
  }, [environmentId, link, supported, unlink]);
}
