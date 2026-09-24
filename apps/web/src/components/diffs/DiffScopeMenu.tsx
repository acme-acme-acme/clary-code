import type { ReviewCommit, RunId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel, formatShortTimestamp } from "~/timestampFormat";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A scope the menu offers; the panel maps it onto its stored selection. */
export type DiffScopeChoice =
  | { readonly kind: "branch" }
  | { readonly kind: "unstaged" }
  | { readonly kind: "commit"; readonly sha: string }
  | { readonly kind: "turn"; readonly runId: RunId };

export interface DiffScopeMenuTurn {
  readonly runId: RunId;
  readonly turnCount: number | undefined;
  readonly fileCount: number;
  readonly completedAt: string;
}

function ScopeOption(props: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly title: ReactNode;
  readonly detail?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.selected}
      onClick={props.onSelect}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{props.title}</span>
        {props.detail ? (
          <span className="truncate text-xs text-muted-foreground">{props.detail}</span>
        ) : null}
      </span>
      {props.selected ? <CheckIcon className="size-4 shrink-0 text-foreground" /> : null}
    </button>
  );
}

function SectionLabel(props: { readonly children: ReactNode }) {
  return (
    <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
      {props.children}
    </div>
  );
}

/**
 * The diff panel's scope chooser: the comparison target, then every change on the branch, only
 * uncommitted work, one commit, or one agent turn.
 */
export function DiffScopeMenu(props: {
  readonly selected: DiffScopeChoice;
  /** What the trigger shows: the scope currently on screen. */
  readonly label: string;
  /** Full scope name, e.g. a commit subject, for the trigger's tooltip. */
  readonly title: string;
  readonly uncommittedFileCount: number | null;
  readonly commits: ReadonlyArray<ReviewCommit>;
  readonly commitsTruncated: boolean;
  readonly turns: ReadonlyArray<DiffScopeMenuTurn>;
  /** Shown at the top while it applies; turns are read from checkpoints, not a branch. */
  readonly targetBranchPicker: ReactNode;
  readonly onSelect: (choice: DiffScopeChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const { timestampFormat } = useClientSettings();
  const { selected } = props;
  const select = (choice: DiffScopeChoice) => {
    props.onSelect(choice);
    setOpen(false);
  };
  const uncommittedDetail =
    props.uncommittedFileCount === null
      ? null
      : props.uncommittedFileCount === 0
        ? "No uncommitted changes"
        : `${props.uncommittedFileCount} ${props.uncommittedFileCount === 1 ? "file" : "files"} changed`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={`Diff scope: ${props.title}. Choose which changes to show`}
                  className={cn(
                    "inline-flex h-6 min-w-0 max-w-44 shrink cursor-pointer items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring",
                    open && "bg-accent/80",
                  )}
                />
              }
            />
          }
        >
          <span className={cn("min-w-0 truncate", selected.kind === "commit" && "font-mono")}>
            {props.label}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
        </TooltipTrigger>
        <TooltipPopup side="top">{props.title}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" sideOffset={6} width="md" padding="none">
        <div className="flex max-h-[min(32rem,70vh)] min-h-0 w-full flex-col overflow-y-auto p-1">
          {props.targetBranchPicker ? (
            <>
              <div className="flex items-center justify-between gap-2 py-0.5 ps-2.5">
                <span className="shrink-0 text-sm text-muted-foreground">Target branch</span>
                {props.targetBranchPicker}
              </div>
              <div className="-mx-1 my-1 h-px bg-border/70" />
            </>
          ) : null}
          <div role="menu" aria-label="Changes to show">
            <ScopeOption
              selected={selected.kind === "branch"}
              onSelect={() => select({ kind: "branch" })}
              title="All changes"
            />
            <ScopeOption
              selected={selected.kind === "unstaged"}
              onSelect={() => select({ kind: "unstaged" })}
              title="Uncommitted changes"
              detail={uncommittedDetail}
            />
            {props.commits.length > 0 ? (
              <>
                <div className="-mx-1 my-1 h-px bg-border/70" />
                <SectionLabel>Commits</SectionLabel>
                {props.commits.map((commit) => (
                  <ScopeOption
                    key={commit.sha}
                    selected={selected.kind === "commit" && selected.sha === commit.sha}
                    onSelect={() => select({ kind: "commit", sha: commit.sha })}
                    title={commit.subject || commit.sha.slice(0, 7)}
                    detail={
                      <>
                        <span className="font-mono">{commit.sha.slice(0, 7)}</span>
                        {commit.authorName ? ` • ${commit.authorName}` : ""}
                        {commit.authoredAt
                          ? ` • ${formatRelativeTimeLabel(commit.authoredAt)}`
                          : ""}
                      </>
                    }
                  />
                ))}
                {props.commitsTruncated ? (
                  <p className="px-2.5 py-1 text-xs text-muted-foreground">
                    Showing the latest {props.commits.length} commits.
                  </p>
                ) : null}
              </>
            ) : null}
            {props.turns.length > 0 ? (
              <>
                <div className="-mx-1 my-1 h-px bg-border/70" />
                <SectionLabel>Agent turns</SectionLabel>
                {props.turns.map((turn) => (
                  <ScopeOption
                    key={turn.runId}
                    selected={selected.kind === "turn" && selected.runId === turn.runId}
                    onSelect={() => select({ kind: "turn", runId: turn.runId })}
                    title={`Turn ${turn.turnCount ?? "?"}`}
                    detail={`${turn.fileCount} ${turn.fileCount === 1 ? "file" : "files"} • ${formatShortTimestamp(turn.completedAt, timestampFormat)}`}
                  />
                ))}
              </>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
