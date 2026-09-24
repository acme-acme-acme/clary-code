import type { FileDiffMetadata } from "@pierre/diffs";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  SquareArrowRightIcon,
  SquareDotIcon,
  SquareMinusIcon,
  SquarePlusIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { cn } from "~/lib/utils";

import { DiffStatLabel } from "../chat/DiffStatLabel";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { buildDiffChangesTreeRows } from "./diffChangesTree.logic";

/** One changed file as the tree lists it. */
export interface DiffChangesTreeFile {
  readonly filePath: string;
  readonly type: FileDiffMetadata["type"];
  readonly additions: number;
  readonly deletions: number;
  /** Marked viewed and unchanged since. */
  readonly viewed: boolean;
}

const INDENT_PX = 12;
const BASE_PADDING_PX = 6;

const filePathOf = (file: DiffChangesTreeFile) => file.filePath;

function FileStatusIcon({ type }: { readonly type: FileDiffMetadata["type"] }) {
  switch (type) {
    case "new":
      return <SquarePlusIcon aria-label="Added" className="size-3.5 shrink-0 text-success" />;
    case "deleted":
      return (
        <SquareMinusIcon aria-label="Deleted" className="size-3.5 shrink-0 text-destructive" />
      );
    case "rename-pure":
    case "rename-changed":
      return <SquareArrowRightIcon aria-label="Renamed" className="size-3.5 shrink-0 text-info" />;
    case "change":
      return <SquareDotIcon aria-label="Modified" className="size-3.5 shrink-0 text-warning" />;
  }
}

/** Vertical guides for each ancestor level, like the file explorer's indent rails. */
function IndentGuides({ depth }: { readonly depth: number }) {
  if (depth === 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-border/70"
          style={{ left: BASE_PADDING_PX + level * INDENT_PX + 6 }}
        />
      ))}
    </>
  );
}

export interface DiffChangesTreeFileActions {
  readonly onOpenFile: (filePath: string) => void;
  readonly onOpenInFiles: (filePath: string) => void;
  readonly onCopyPath: (filePath: string) => void;
}

const DiffChangesFileRow = memo(function DiffChangesFileRow(props: {
  readonly file: DiffChangesTreeFile;
  readonly name: string;
  readonly depth: number;
  readonly selected: boolean;
  readonly actions: DiffChangesTreeFileActions;
}) {
  const { file, actions } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const style: CSSProperties = { paddingLeft: BASE_PADDING_PX + props.depth * INDENT_PX };
  return (
    <div
      role="treeitem"
      aria-selected={props.selected}
      data-diff-file-path={file.filePath}
      className={cn(
        "group/row relative flex h-6 items-center rounded-md pr-1.5",
        props.selected ? "bg-accent" : "hover:bg-accent/60",
      )}
      style={style}
    >
      <IndentGuides depth={props.depth} />
      <button
        type="button"
        onClick={() => actions.onOpenFile(file.filePath)}
        aria-label={`Open diff for ${file.filePath}`}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center text-left text-[13px] text-foreground outline-none focus-visible:underline"
      >
        <span className={cn("truncate", file.viewed && "text-muted-foreground")}>{props.name}</span>
      </button>
      <span
        className={cn(
          "ml-2 flex shrink-0 items-center gap-2",
          menuOpen ? "hidden" : "group-hover/row:hidden group-focus-within/row:hidden",
        )}
      >
        {file.viewed ? (
          <CheckIcon aria-label="Viewed" className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <DiffStatLabel
            additions={file.additions}
            deletions={file.deletions}
            layout="inline"
            className="text-[11px]"
          />
        )}
        <FileStatusIcon type={file.type} />
      </span>
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          render={<Button type="button" size="icon-micro" variant="ghost" />}
          aria-label={`Actions for ${file.filePath}`}
          className={cn(
            "ml-2 shrink-0",
            menuOpen ? "flex" : "hidden group-hover/row:flex group-focus-within/row:flex",
          )}
        >
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" sideOffset={4} className="min-w-44">
          <MenuItem onClick={() => actions.onOpenFile(file.filePath)}>Open diff</MenuItem>
          {file.type === "deleted" ? null : (
            <MenuItem onClick={() => actions.onOpenInFiles(file.filePath)}>Open file</MenuItem>
          )}
          <MenuItem onClick={() => actions.onCopyPath(file.filePath)}>Copy path</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
});

/**
 * The changed files as a folder tree. A row opens the file's diff; the chevron that replaces its
 * stats on hover holds the rest of the file's actions.
 */
export function DiffChangesTree(props: {
  readonly files: ReadonlyArray<DiffChangesTreeFile>;
  readonly selectedPath: string | null;
  readonly actions: DiffChangesTreeFileActions;
  readonly ariaLabel: string;
}) {
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  // A newly selected file (next/previous in the diff view) reopens any folder hiding it.
  const [revealedPath, setRevealedPath] = useState(props.selectedPath);
  if (props.selectedPath !== revealedPath) {
    setRevealedPath(props.selectedPath);
    const selected = props.selectedPath;
    if (selected && [...collapsedPaths].some((path) => selected.startsWith(`${path}/`))) {
      setCollapsedPaths(
        new Set([...collapsedPaths].filter((path) => !selected.startsWith(`${path}/`))),
      );
    }
  }
  useEffect(() => {
    if (!props.selectedPath) return;
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-diff-file-path="${CSS.escape(props.selectedPath)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [props.selectedPath]);
  const rows = useMemo(
    () => buildDiffChangesTreeRows(props.files, filePathOf, collapsedPaths),
    [collapsedPaths, props.files],
  );

  const toggleDirectory = (path: string) =>
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div ref={containerRef} role="tree" aria-label={props.ariaLabel} className="px-1 pb-2">
      {rows.map((row) =>
        row.kind === "directory" ? (
          <button
            key={`dir:${row.path}`}
            type="button"
            role="treeitem"
            aria-expanded={row.expanded}
            onClick={() => toggleDirectory(row.path)}
            className="relative flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-[13px] text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60"
            style={{ paddingLeft: BASE_PADDING_PX + row.depth * INDENT_PX - 4 }}
          >
            <IndentGuides depth={row.depth} />
            {row.expanded ? (
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            ) : (
              <ChevronRightIcon className="size-3.5 shrink-0 opacity-70" />
            )}
            {row.expanded ? (
              <FolderOpenIcon className="size-3.5 shrink-0" />
            ) : (
              <FolderIcon className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 truncate font-mono text-xs">{row.segments.join(" / ")}</span>
          </button>
        ) : (
          <DiffChangesFileRow
            key={`file:${row.path}`}
            file={row.file}
            name={row.name}
            depth={row.depth}
            selected={row.path === props.selectedPath}
            actions={props.actions}
          />
        ),
      )}
    </div>
  );
}
