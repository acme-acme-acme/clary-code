import type { ThreadLinearIssueLink } from "@t3tools/contracts";
import type { MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { linearIssueStateColor, resolveThreadLinearIssueBadge } from "./linearIssues.logic";

/** Linear's own workflow-state color; muted until the first sync reports one. */
export function LinearIssueStateDot({
  issue,
  className,
}: {
  issue: ThreadLinearIssueLink;
  className?: string;
}) {
  const color = linearIssueStateColor(issue);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        color === null && "bg-muted-foreground/40",
        className,
      )}
      style={color === null ? undefined : { backgroundColor: color }}
    />
  );
}

/**
 * The linked-Linear-issue badge in a sidebar row: the first issue's identifier and state dot,
 * with a count of the rest. Hover lists them all; a click opens the thread's issues panel.
 */
export function ThreadLinearIssueBadgeControl({
  issues,
  onOpen,
}: {
  issues: ReadonlyArray<ThreadLinearIssueLink> | undefined;
  onOpen: () => void;
}) {
  const badge = resolveThreadLinearIssueBadge(issues);
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
              event.preventDefault();
              event.stopPropagation();
              onOpen();
            }}
          />
        }
      >
        <LinearIssueStateDot issue={badge.lead} className="mr-0.5" />
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
                <span className="ml-auto shrink-0 pl-1 text-[10px]">
                  {issue.snapshot.state.name}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
}
