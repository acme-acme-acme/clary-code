import type { ScopedThreadRef, ThreadLinearIssueLink } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  LinkIcon,
  ListTodoIcon,
  MoreHorizontalIcon,
  PlusIcon,
  UnlinkIcon,
} from "lucide-react";
import { useCallback, type MouseEvent } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useLinearIssueLinking } from "~/hooks/useLinearIssueLinking";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { openLinkLinearIssueDialog } from "./LinkLinearIssueDialog";
import { LinearIssueStateDot } from "./ThreadLinearIssueBadge";

const SOURCE_LABELS: Record<ThreadLinearIssueLink["source"], string> = {
  manual: "Linked by you",
  agent: "Linked by the agent",
  delegated: "Delegated from Linear",
};

/** Linear lives outside the app, so issues always open in the system browser. */
function openInLinear(event: MouseEvent<HTMLElement> | null, url: string) {
  event?.preventDefault();
  void readLocalApi()
    ?.shell.openExternal(url)
    .catch((error: unknown) => console.error(error));
}

function IssueRow({
  issue,
  onUnlink,
}: {
  issue: ThreadLinearIssueLink;
  onUnlink: ((issue: ThreadLinearIssueLink) => void) | null;
}) {
  const snapshot = issue.snapshot;
  return (
    <div className="group/linear-row flex w-full items-center gap-2 rounded-md py-1 pr-1 pl-2 hover:bg-accent/60">
      <LinearIssueStateDot issue={issue} />
      <a
        href={issue.url}
        onClick={(event) => openInLinear(event, issue.url)}
        className="flex min-w-0 flex-1 flex-col"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {issue.identifier}
          </span>
          <span className="min-w-0 truncate text-sm">{snapshot?.title ?? "Not synced yet"}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[.7rem] text-muted-foreground">
          {snapshot ? <span className="shrink-0">{snapshot.state.name}</span> : null}
          {snapshot?.assignee ? <span className="truncate">· {snapshot.assignee}</span> : null}
          <span className={cn("shrink-0", snapshot ? "ml-auto" : undefined)}>
            {SOURCE_LABELS[issue.source]} · {formatRelativeTimeLabel(issue.linkedAt)}
          </span>
        </span>
      </a>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-micro"
              aria-label={`Actions for ${issue.identifier}`}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup align="end" side="bottom">
          <MenuItem onClick={() => void writeTextToClipboard(issue.url, "link")}>
            <LinkIcon className="size-3.5" />
            Copy link
          </MenuItem>
          <MenuItem onClick={() => openInLinear(null, issue.url)}>
            <ArrowUpRightIcon className="size-3.5" />
            Open in Linear
          </MenuItem>
          {onUnlink ? (
            <MenuItem onClick={() => onUnlink(issue)}>
              <UnlinkIcon className="size-3.5" />
              Unlink from thread
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** The thread's linked Linear issues, with the synced state Linear reports for each. */
export function ThreadLinearIssuesPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const linking = useLinearIssueLinking(threadRef.environmentId);
  const issues = thread?.linearIssues ?? [];
  const openLinkDialog = useCallback(() => openLinkLinearIssueDialog(threadRef), [threadRef]);
  const handleUnlink = useCallback(
    (issue: ThreadLinearIssueLink) => linking.unlinkIssue(threadRef, issue.identifier),
    [linking, threadRef],
  );

  if (issues.length === 0) {
    return (
      <Empty className="min-h-0 justify-center-safe">
        <EmptyMedia variant="icon">
          <ListTodoIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No linked Linear issues</EmptyTitle>
          <EmptyDescription>
            {linking.supported
              ? "Issues the agent works on land here. Link one yourself by identifier or URL."
              : "This environment does not support linking Linear issues."}
          </EmptyDescription>
        </EmptyHeader>
        {linking.supported ? (
          <Button size="sm" variant="outline" onClick={openLinkDialog}>
            <PlusIcon className="size-3.5" />
            Link Linear issue
          </Button>
        ) : null}
      </Empty>
    );
  }

  let lastSynced: string | null = null;
  for (const issue of issues) {
    const at = issue.snapshot?.syncedAt;
    if (at !== undefined && (lastSynced === null || at > lastSynced)) lastSynced = at;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-1.5">
          {issues.map((issue) => (
            <IssueRow
              key={issue.identifier}
              issue={issue}
              onUnlink={linking.supported ? handleUnlink : null}
            />
          ))}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-[.7rem] text-muted-foreground">
        <span>
          {issues.length} linked
          {lastSynced
            ? ` · synced ${formatRelativeTimeLabel(lastSynced)}`
            : " · not synced with Linear yet"}
        </span>
        {linking.supported ? (
          <Button size="xs" variant="ghost" onClick={openLinkDialog}>
            <PlusIcon className="size-3.5" />
            Link
          </Button>
        ) : null}
      </footer>
    </div>
  );
}
