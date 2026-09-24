import type { EnvironmentId, LinearIssueDetail } from "@t3tools/contracts";
import { useCallback } from "react";

import { readLinearIssueDetail } from "~/state/linearIssues";
import { useAtomCommand } from "~/state/use-atom-command";
import { openInLinear } from "./openInLinear";

/** Linear's review page for the issue's first linked pull request that has one. */
export function linearIssueReviewUrl(detail: Pick<LinearIssueDetail, "attachments">) {
  return detail.attachments.find((attachment) => attachment.reviewUrl)?.reviewUrl ?? null;
}

/**
 * Cmd-shift-click on a linked issue: open its pull request's review in Linear,
 * or the issue itself when there is none (or no Linear sign-in to find it).
 */
export function useOpenLinearReview(environmentId: EnvironmentId) {
  const readDetail = useAtomCommand(readLinearIssueDetail, { reportFailure: false });
  return useCallback(
    (issue: { readonly identifier: string; readonly url: string }) => {
      void readDetail({ environmentId, input: { reference: issue.identifier } }).then((result) => {
        const reviewUrl = result._tag === "Success" ? linearIssueReviewUrl(result.value) : null;
        openInLinear(null, reviewUrl ?? issue.url);
      });
    },
    [environmentId, readDetail],
  );
}
