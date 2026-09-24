import type { EnvironmentId, ThreadLinearIssueLink } from "@t3tools/contracts";
import type { MouseEvent } from "react";

import { shouldOpenPullRequestExternally } from "~/lib/openPullRequestLink";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveThreadLinearIssueBadge } from "./linearIssues.logic";
import { LinearStatusIcon } from "./LinearStatusIcon";
import { openInLinear } from "./openInLinear";
import { useOpenLinearReview } from "./useOpenLinearReview";

/** Linear's own workflow-state icon; a muted backlog ring until the first sync reports a state. */
export function LinearIssueStateDot({
  issue,
  className,
}: {
  issue: ThreadLinearIssueLink;
  className?: string;
}) {
  return <LinearStatusIcon state={issue.snapshot?.state ?? null} className={className} />;
}

/**
 * The linked-Linear-issue badge in a sidebar row: the first issue's identifier and state dot,
 * with a count of the rest. Hover lists them all; a click opens the issue's page (or the list when
 * there are several), and cmd/ctrl-click opens the first issue in Linear, like the pull request
 * badge beside it; cmd/ctrl-shift-click opens its pull request review in Linear.
 */
export function ThreadLinearIssueBadgeControl({
  environmentId,
  issues,
  onOpen,
}: {
  environmentId: EnvironmentId;
  issues: ReadonlyArray<ThreadLinearIssueLink> | undefined;
  onOpen: () => void;
}) {
  const badge = resolveThreadLinearIssueBadge(issues);
  const openReview = useOpenLinearReview(environmentId);
  if (issues === undefined || badge === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InlineButton
            tone="muted"
            aria-label={badge.label}
            onPointerDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
            onClick={(event: MouseEvent<HTMLElement>) => {
              event.stopPropagation();
              if (shouldOpenPullRequestExternally(event)) {
                event.preventDefault();
                if (event.shiftKey) openReview(badge.lead);
                else openInLinear(event, badge.lead.url);
                return;
              }
              event.preventDefault();
              onOpen();
            }}
          />
        }
      >
        <LinearIssueStateDot issue={badge.lead} className="mr-0.5 size-3" />
        <span className="font-normal text-xs tabular-nums">{badge.text}</span>
      </TooltipTrigger>
      <TooltipPopup
        side="top"
        sideOffset={0}
        variant="glass"
        className="w-72 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
      >
        <ul className="flex flex-col gap-1">
          {issues.map((issue) => (
            <li key={issue.identifier} className="flex min-w-0 items-center gap-2 px-1 py-0.5">
              <LinearIssueStateDot issue={issue} />
              <span className="shrink-0 font-mono tabular-nums">{issue.identifier}</span>
              <span className="min-w-0 truncate text-foreground/75">
                {issue.snapshot?.title ?? "Not synced yet"}
              </span>
              {issue.snapshot ? (
                <span className="ml-auto shrink-0 pl-1 text-3xs">{issue.snapshot.state.name}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
}
