import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import { useParams } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ReviewDiffPreviewSourceRequest, ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FileTextIcon,
  FolderTreeIcon,
  GitCompareArrowsIcon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { useFileContextMenuHandler } from "../fileContextMenu";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { cn } from "~/lib/utils";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffCollapseIconClassName,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import { useProject, useThreadProjection, useThreadShell } from "../state/entities";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { DiffChangesTree, type DiffChangesTreeFile } from "./diffs/DiffChangesTree";
import { DiffCodeIntelligence } from "./diffs/DiffCodeIntelligence";
import { orderDiffChangesTreeFiles } from "./diffs/diffChangesTree.logic";
import { DiffScopeMenu, type DiffScopeChoice, type DiffScopeMenuTurn } from "./diffs/DiffScopeMenu";
import { DiffTargetBranchPicker } from "./diffs/DiffTargetBranchPicker";
import { RightPanelResizeHandle } from "./preview/RightPanelResizeHandle";
import { diffViewedStat, isDiffFileViewed, type DiffViewedMark } from "./diffs/diffViewed.logic";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";
import { createGitDiffFileContentsLoader } from "../lib/diffFileContents";

import { useReviewFilePatches } from "./diffs/useReviewFilePatches";
import { DiffFileLoadingBoundary } from "./diffs/DiffFileLoadingBoundary";
import { DiffFileStatus } from "./diffs/DiffFileStatus";

type DiffThemeType = "light" | "dark";
const DIFF_EXPAND_UNCHANGED_STORAGE_KEY = "t3code.diffExpandUnchanged";
const DIFF_FILE_TREE_STORAGE_KEY = "t3code.diffFileTreeOpen";
const DIFF_FILE_TREE_WIDTH_STORAGE_KEY = "t3code.diffFileTreeWidth";
const fileEntryCache = new WeakMap<
  FileDiffMetadata,
  { fileDiff: FileDiffMetadata; fileKey: string; fileVersion: number }
>();

function getCachedFileEntry(fileDiff: FileDiffMetadata) {
  const cached = fileEntryCache.get(fileDiff);
  if (cached) return cached;
  const entry = {
    fileDiff,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
  };
  fileEntryCache.set(fileDiff, entry);
  return entry;
}

interface CollapsedDiffFilesState {
  readonly scopeKey: string | null;
  readonly fileKeys: ReadonlySet<string>;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
}

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  workspaceMutationId,
}: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const diffLayout = settings.diffLayout;
  const updateClientSettings = useUpdateClientSettings();
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  // With the tree open the panel shows one file at a time; hidden, every file in one stream.
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    DIFF_FILE_TREE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const { width: fileTreeWidth, handlers: fileTreeResizeHandlers } = useResizableWidth({
    storageKey: DIFF_FILE_TREE_WIDTH_STORAGE_KEY,
    defaultWidth: 256,
    minWidth: 160,
    maxWidth: 480,
    edge: "left",
  });
  const [expandUnchanged, setExpandUnchanged] = useLocalStorage(
    DIFF_EXPAND_UNCHANGED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<CollapsedDiffFilesState>(() => ({
    scopeKey: null,
    fileKeys: EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  }));
  const [codeViewRevision, setCodeViewRevision] = useState(0);
  const [codeView, setCodeView] = useState<AnnotatableCodeViewHandle | null>(null);

  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useThreadShell(routeThreadRef);
  const activeThreadProjection = useThreadProjection(routeThreadRef)?.projection ?? null;
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useProject(
    activeThread && activeProjectId
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        }
      : null,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  const activeRepositoryRoot = activeThread?.worktreePath
    ? undefined
    : activeProject?.repositoryIdentity?.rootPath;
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
  );
  const onFileContextMenu = useFileContextMenuHandler(activeThread?.environmentId ?? null);
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeThread?.environmentId ?? null,
    serverConfig?.availableEditors ?? [],
  );
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const gitStatusQuery = useEnvironmentQuery(
    activeThread !== null && activeThread !== undefined && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, routeThreadRef),
  );
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByRunId } =
    useTurnDiffSummaries(activeThreadProjection);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[left.runId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[right.runId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByRunId, turnDiffSummaries],
  );

  useEffect(() => {
    if (!routeThreadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      routeThreadRef,
      orderedTurnDiffSummaries.map((summary) => summary.runId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);

  const selectedRunId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  const selectedCommitSha = diffSelection.kind === "commit" ? diffSelection.sha : null;
  const selectedGitScope = diffSelection.kind === "unstaged" ? "unstaged" : "branch";
  const selectedBaseRef = diffSelection.kind === "branch" ? diffSelection.baseRef : null;
  const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
  const selectedFileRevealRequestId =
    diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
  const selectedTurn =
    selectedRunId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.runId === selectedRunId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[selectedTurn.runId]);
  const latestTurn = orderedTurnDiffSummaries[0];
  const selectedScopeLabel =
    selectedRunId === null
      ? selectedCommitSha
        ? selectedCommitSha.slice(0, 7)
        : selectedGitScope === "unstaged"
          ? "Uncommitted changes"
          : "All changes"
      : selectedTurn?.runId === latestTurn?.runId
        ? "Latest turn"
        : `Turn ${selectedCheckpointTurnCount ?? "?"}`;
  const reviewSectionId = selectedTurn
    ? `turn:${selectedTurn.runId}`
    : selectedCommitSha
      ? `commit:${selectedCommitSha}`
      : selectedGitScope;
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : null;
  const codeViewMountKey = `${collapseScopeKey ?? reviewSectionId}:${codeViewRevision}`;
  const reviewSectionTitle = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
    : selectedCommitSha
      ? `Commit ${selectedCommitSha.slice(0, 7)}`
      : selectedGitScope === "unstaged"
        ? "Uncommitted changes"
        : "All changes";
  // All changes include uncommitted work; a commit is read on its own. Uncommitted changes keep
  // the default preview, which older servers also answer.
  const previewSourceRequest = useMemo<ReviewDiffPreviewSourceRequest | undefined>(
    () =>
      selectedCommitSha
        ? { commit: selectedCommitSha }
        : diffSelection.kind === "branch"
          ? "all"
          : undefined,
    [diffSelection.kind, selectedCommitSha],
  );
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.runId}` : null,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  );
  const primaryBranchDiffPreview = useEnvironmentQuery(
    selectedRunId === null && activeThread && activeCwd
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ...(previewSourceRequest ? { source: previewSourceRequest } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const shouldRetryBranchDiffAtEnvironmentCwd =
    selectedRunId === null &&
    primaryBranchDiffPreview.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== activeCwd;
  const fallbackBranchDiffPreview = useEnvironmentQuery(
    shouldRetryBranchDiffAtEnvironmentCwd && activeThread && serverConfig
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: serverConfig.cwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ...(previewSourceRequest ? { source: previewSourceRequest } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const branchDiffPreview = shouldRetryBranchDiffAtEnvironmentCwd
    ? fallbackBranchDiffPreview
    : primaryBranchDiffPreview;
  const canRefreshGitDiff =
    isGitRepo && selectedRunId === null && activeThread != null && activeCwd != null;
  const activeThreadRefreshKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;

  const previewSources = branchDiffPreview.data?.sources ?? [];
  const selectedGitSource = selectedCommitSha
    ? previewSources.find((source) => source.kind === "commit")
    : selectedGitScope === "unstaged"
      ? previewSources.find((source) => source.kind === "working-tree")
      : // Servers without the `all` source answer with the committed branch range.
        (previewSources.find((source) => source.kind === "all") ??
        previewSources.find((source) => source.kind === "branch-range"));
  const commitsBaseRef = useDiffPanelStore((state) =>
    routeThreadRef
      ? (state.branchBaseRefByThreadKey[scopedThreadKey(routeThreadRef)] ?? null)
      : null,
  );
  const branchCommits = useEnvironmentQuery(
    isGitRepo && activeThread && activeCwd
      ? reviewEnvironment.commits({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd, ...(commitsBaseRef ? { baseRef: commitsBaseRef } : {}) },
        })
      : null,
  );
  const refreshPreviewQuery = branchDiffPreview.refresh;
  const refreshDiffFromUserAction = refreshPreviewQuery;

  const currentLoadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    const preview = branchDiffPreview.data;
    if (selectedRunId !== null || !activeThread || !preview || !selectedGitSource) {
      return undefined;
    }

    return createGitDiffFileContentsLoader(getDiffFileContents, {
      environmentId: activeThread.environmentId,
      cwd: preview.cwd,
      sourceKind: selectedGitSource.kind,
      baseRef: selectedGitSource.baseRef,
      headRef: selectedGitSource.headRef,
      cacheKey: selectedGitSource.diffHash,
    });
  }, [activeThread, branchDiffPreview.data, getDiffFileContents, selectedGitSource, selectedRunId]);
  const loadDiffFilesRef = useRef(currentLoadDiffFiles);
  loadDiffFilesRef.current = currentLoadDiffFiles;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(async (fileDiff) => {
    const loader = loadDiffFilesRef.current;
    if (!loader) throw new Error("Diff file contents are unavailable for this selection.");
    return loader(fileDiff);
  }, []);
  const gitDiff = selectedGitSource?.diff;

  const selectedPatch = selectedTurn ? activeCheckpointDiff.data?.diff : gitDiff;
  const isSelectedPatchTruncated = !selectedTurn && selectedGitSource?.truncated === true;
  const isLoadingSelectedPatch = selectedTurn
    ? activeCheckpointDiff.isPending
    : branchDiffPreview.isPending;
  const selectedPatchError = selectedTurn ? activeCheckpointDiff.error : branchDiffPreview.error;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const lazySource =
    !selectedTurn && selectedGitSource?.truncated && selectedGitSource.files
      ? selectedGitSource
      : null;
  const renderablePatch = useMemo(
    () =>
      lazySource
        ? null
        : getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`, {
            compactPartialHunkOffsets: selectedRunId === null,
          }),
    [lazySource, resolvedTheme, selectedPatch, selectedRunId],
  );
  const fileStats = useMemo(
    () => new Map(lazySource?.files?.map((file) => [file.path, file])),
    [lazySource?.files],
  );
  const {
    scope: filePatchScope,
    isPending: areFilePatchesPending,
    fileStates,
    retry,
    requestFile,
    readyFilePaths,
    renderableFiles,
    settledFileCount,
    loadNextFiles,
  } = useReviewFilePatches({
    environmentId: activeThread?.environmentId,
    cwd: branchDiffPreview.data?.cwd,
    source: lazySource,
    sourceRequest: previewSourceRequest,
    baseRef: lazySource?.baseRef ?? selectedBaseRef,
    ignoreWhitespace: diffIgnoreWhitespace,
    theme: resolvedTheme,
    revision: branchDiffPreview.data
      ? DateTime.formatIso(branchDiffPreview.data.generatedAt)
      : undefined,
    preview: renderablePatch,
  });
  const refreshBranchDiffPreview = refreshPreviewQuery;

  useEffect(() => {
    if (!canRefreshGitDiff) return;
    const refreshOnFocus = () => refreshBranchDiffPreview();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [canRefreshGitDiff, refreshBranchDiffPreview]);

  useWorkspaceMutationRefresh({
    enabled: canRefreshGitDiff,
    mutationId: workspaceMutationId,
    refresh: refreshBranchDiffPreview,
    resourceKey: `diff:${activeThreadRefreshKey ?? ""}`,
  });

  const isRefreshingDiff = branchDiffPreview.isPending || areFilePatchesPending;
  const renderableFileEntries = useMemo(
    () => renderableFiles.map(getCachedFileEntry),
    [renderableFiles],
  );
  const viewedMarks = useDiffPanelStore((state) =>
    routeThreadRef
      ? state.viewedByThreadKey[scopedThreadKey(routeThreadRef)]?.[reviewSectionId]
      : undefined,
  );
  const currentViewedMark = useCallback(
    (fileDiff: FileDiffMetadata): DiffViewedMark => ({
      // A placeholder has no patch yet, so only its line counts say whether it changed.
      version: fileDiff.cacheKey?.endsWith(":pending")
        ? null
        : getCachedFileEntry(fileDiff).fileVersion,
      stat: diffViewedStat(fileStats.get(resolveFileDiffPath(fileDiff))),
    }),
    [fileStats],
  );
  // `changedKeys` were marked viewed but their diff has moved on since.
  const viewedFiles = useMemo(() => {
    const keys = new Set<string>();
    const paths = new Set<string>();
    const changedKeys = new Set<string>();
    for (const { fileDiff, fileKey } of renderableFileEntries) {
      const path = resolveFileDiffPath(fileDiff);
      const mark = viewedMarks?.[path];
      if (!mark) continue;
      if (isDiffFileViewed(mark, currentViewedMark(fileDiff))) {
        keys.add(fileKey);
        paths.add(path);
      } else {
        changedKeys.add(fileKey);
      }
    }
    return { keys, paths, changedKeys };
  }, [currentViewedMark, renderableFileEntries, viewedMarks]);
  // Viewed files start collapsed, like every file when the setting asks for it.
  const defaultCollapsedDiffFileKeys = useMemo(
    () =>
      settings.diffFilesCollapsed
        ? new Set(renderableFileEntries.map((file) => file.fileKey))
        : viewedFiles.keys.size > 0
          ? viewedFiles.keys
          : EMPTY_COLLAPSED_DIFF_FILE_KEYS,
    [renderableFileEntries, settings.diffFilesCollapsed, viewedFiles.keys],
  );
  const collapsedDiffFileKeys =
    collapsedDiffFiles.scopeKey === collapseScopeKey
      ? collapsedDiffFiles.fileKeys
      : defaultCollapsedDiffFileKeys;
  const renderLoadingBoundary = useCallback(
    () =>
      settledFileCount < renderableFiles.length ? (
        <DiffFileLoadingBoundary
          load={loadNextFiles}
          count={renderableFiles.length - settledFileCount}
        />
      ) : null,
    [settledFileCount, renderableFiles.length, loadNextFiles],
  );
  // While the tree is open one file shows at a time: the one picked in the tree or opened from
  // the chat, else the first the tree lists. A file that leaves the scope falls back to the first.
  const openFile = useDiffPanelStore((state) =>
    routeThreadRef ? state.openFileByThreadKey[scopedThreadKey(routeThreadRef)] : undefined,
  );
  const setOpenFile = useCallback(
    (path: string) => {
      if (!routeThreadRef || !collapseScopeKey) return;
      useDiffPanelStore.getState().openFile(routeThreadRef, collapseScopeKey, path);
    },
    [collapseScopeKey, routeThreadRef],
  );
  // A file opened from the chat, including a repeat request for the same file, opens here.
  useEffect(() => {
    if (selectedFilePath) setOpenFile(selectedFilePath);
  }, [selectedFilePath, selectedFileRevealRequestId, setOpenFile]);
  const orderedFileEntries = useMemo(
    () =>
      orderDiffChangesTreeFiles(renderableFileEntries, (entry) =>
        resolveFileDiffPath(entry.fileDiff),
      ),
    [renderableFileEntries],
  );
  const singleFileEntry = fileTreeOpen
    ? (orderedFileEntries.find(
        (entry) =>
          openFile?.scope === collapseScopeKey &&
          resolveFileDiffPath(entry.fileDiff) === openFile.path,
      ) ?? orderedFileEntries[0])
    : undefined;
  const singleFilePosition = singleFileEntry ? orderedFileEntries.indexOf(singleFileEntry) : -1;
  const stepOpenFile = (delta: -1 | 1) => {
    const next = orderedFileEntries[singleFilePosition + delta];
    if (next) setOpenFile(resolveFileDiffPath(next.fileDiff));
  };
  const singleFilePath = singleFileEntry ? resolveFileDiffPath(singleFileEntry.fileDiff) : null;
  const singleFileIndex = singleFileEntry ? renderableFileEntries.indexOf(singleFileEntry) : -1;
  const singleFileReady =
    !lazySource || (singleFilePath !== null && readyFilePaths.has(singleFilePath));
  useEffect(() => {
    if (lazySource && singleFileIndex >= 0 && !singleFileReady) requestFile(singleFileIndex);
  }, [lazySource, requestFile, singleFileIndex, singleFileReady]);
  const codeViewFiles = useMemo(
    () =>
      (singleFileEntry
        ? singleFileReady
          ? [singleFileEntry]
          : []
        : renderableFileEntries.filter(
            ({ fileDiff }) => !lazySource || readyFilePaths.has(resolveFileDiffPath(fileDiff)),
          )
      ).map(({ fileDiff, fileKey, fileVersion }) => {
        return {
          fileDiff,
          filePath: resolveFileDiffPath(fileDiff),
          fileKey,
          fileVersion,
          // Header-only placeholders use the viewer's collapsed geometry until their patch arrives.
          collapsed:
            (!singleFileEntry && collapsedDiffFileKeys.has(fileKey)) ||
            fileDiff.cacheKey?.endsWith(":pending") === true,
        };
      }),
    [
      collapsedDiffFileKeys,
      renderableFileEntries,
      lazySource,
      readyFilePaths,
      singleFileEntry,
      singleFileReady,
    ],
  );
  const diffFileKeys = useMemo(
    () => renderableFileEntries.map((file) => file.fileKey),
    [renderableFileEntries],
  );
  const allDiffFilesCollapsed = areAllDiffFilesCollapsed(diffFileKeys, collapsedDiffFileKeys);
  const diffLineStat = useMemo(() => {
    if (!selectedTurn && selectedGitSource?.files) {
      return selectedGitSource.files.reduce(
        (total, file) => ({
          additions: total.additions + file.additions,
          deletions: total.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
    }
    return getDiffLineStat(renderableFiles);
  }, [renderableFiles, selectedGitSource, selectedTurn]);
  const treeFiles = useMemo(
    () =>
      renderableFileEntries.map(({ fileDiff }): DiffChangesTreeFile => {
        const filePath = resolveFileDiffPath(fileDiff);
        const stat = fileStats.get(filePath) ?? getDiffLineStat([fileDiff]);
        return {
          filePath,
          type: fileDiff.type,
          additions: stat.additions,
          deletions: stat.deletions,
          viewed: viewedFiles.paths.has(filePath),
        };
      }),
    [fileStats, renderableFileEntries, viewedFiles.paths],
  );
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => toastManager.add({ type: "success", title: "Path copied" }),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Failed to copy path", description: error.message }),
  });
  const selectedDiffFileKey = selectedFilePath
    ? (codeViewFiles.find((candidate) => candidate.filePath === selectedFilePath)?.fileKey ?? null)
    : null;

  useEffect(() => {
    if (!selectedDiffFileKey || !codeView?.getInstance()) return;
    codeView.scrollTo({ type: "item", id: selectedDiffFileKey, align: "start" });
  }, [codeView, codeViewMountKey, selectedDiffFileKey, selectedFileRevealRequestId]);

  const treeRevealScope = useMemo(
    () => ({ collapseScopeKey, diffSelection }),
    [collapseScopeKey, diffSelection],
  );
  const requestTreeReveal = useCodeViewFileReveal(
    codeView,
    treeRevealScope,
    codeViewFiles.map((file) => file.fileKey),
  );
  const revealDiffFile = useCallback(
    (filePath: string) => {
      if (fileTreeOpen) {
        setOpenFile(filePath);
        return;
      }
      const index = renderableFileEntries.findIndex(
        (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
      );
      const file = renderableFileEntries[index];
      if (!file) return;
      setCollapsedDiffFiles((current) => {
        const next = new Set(
          current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys,
        );
        next.delete(file.fileKey);
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
      if (lazySource && index >= settledFileCount) {
        requestFile(index);
      }
      requestTreeReveal(file.fileKey);
    },
    [
      fileTreeOpen,
      setOpenFile,
      renderableFileEntries,
      collapseScopeKey,
      defaultCollapsedDiffFileKeys,
      requestTreeReveal,
      lazySource,
      settledFileCount,
      requestFile,
    ],
  );

  const externalRevealRef = useRef<{ cache: string; key: string } | null>(null);
  useEffect(() => {
    if (!lazySource || !selectedFilePath) return;
    const key = `${selectedFilePath}:${selectedFileRevealRequestId}`;
    if (
      externalRevealRef.current?.cache === filePatchScope &&
      externalRevealRef.current.key === key
    )
      return;
    externalRevealRef.current = { cache: filePatchScope, key };
    revealDiffFile(selectedFilePath);
  }, [lazySource, selectedFilePath, selectedFileRevealRequestId, filePatchScope, revealDiffFile]);

  const openDiffFile = useCallback(
    (filePath: string) => {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        activeCwd,
        repositoryRoot: activeRepositoryRoot,
        openInEditor: (targetPath) => {
          void (async () => {
            const result = await openInPreferredEditor(targetPath);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              console.warn("Failed to open diff file in editor.", {
                operation: "open-diff-file",
                ...(routeThreadRef
                  ? {
                      environmentId: routeThreadRef.environmentId,
                      threadId: routeThreadRef.threadId,
                    }
                  : {}),
                ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
              });
            }
          })();
        },
      });
    },
    [activeCwd, activeRepositoryRoot, openInPreferredEditor, routeThreadRef],
  );
  const codeSurfaceRef = useRef<HTMLDivElement>(null);
  const openCodeLocation = useCallback(
    (path: string, line: number) => {
      if (routeThreadRef) useRightPanelStore.getState().openFile(routeThreadRef, path, line);
    },
    [routeThreadRef],
  );
  const toggleDiffFileCollapsed = useCallback(
    (fileKey: string) => {
      setCollapsedDiffFiles((current) => {
        const next = new Set(
          current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys,
        );
        if (next.has(fileKey)) {
          next.delete(fileKey);
        } else {
          next.add(fileKey);
        }
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
    },
    [collapseScopeKey, defaultCollapsedDiffFileKeys],
  );

  // Marking a file viewed collapses it and unmarking expands it again.
  const toggleDiffFileViewed = useCallback(
    (fileDiff: FileDiffMetadata) => {
      if (!routeThreadRef) return;
      const { fileKey } = getCachedFileEntry(fileDiff);
      const viewed = viewedFiles.keys.has(fileKey);
      useDiffPanelStore
        .getState()
        .setFileViewed(
          routeThreadRef,
          reviewSectionId,
          resolveFileDiffPath(fileDiff),
          viewed ? null : currentViewedMark(fileDiff),
        );
      setCollapsedDiffFiles((current) => {
        const next = new Set(
          current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys,
        );
        if (viewed) next.delete(fileKey);
        else next.add(fileKey);
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
    },
    [
      collapseScopeKey,
      currentViewedMark,
      defaultCollapsedDiffFileKeys,
      reviewSectionId,
      routeThreadRef,
      viewedFiles.keys,
    ],
  );

  const toggleDiffFileCollapse = useCallback(() => {
    setCodeViewRevision((current) => current + 1);
    setCollapsedDiffFiles((current) => {
      const currentKeys =
        current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys;

      return {
        scopeKey: collapseScopeKey,
        fileKeys: toggleAllDiffFiles(diffFileKeys, currentKeys),
      };
    });
  }, [collapseScopeKey, defaultCollapsedDiffFileKeys, diffFileKeys]);

  // Full file shows each file's unchanged lines too, which needs the file contents loader.
  const canExpandUnchanged = currentLoadDiffFiles !== undefined;
  const diffViewMode = expandUnchanged && canExpandUnchanged ? "file" : diffLayout;

  const selectScope = (choice: DiffScopeChoice) => {
    if (!routeThreadRef) return;
    const store = useDiffPanelStore.getState();
    switch (choice.kind) {
      case "branch":
      case "unstaged":
        store.selectGitScope(routeThreadRef, choice.kind);
        return;
      case "commit":
        store.selectCommit(routeThreadRef, choice.sha);
        return;
      case "turn":
        store.selectTurn(routeThreadRef, choice.runId);
        return;
    }
  };
  const selectedScopeChoice: DiffScopeChoice = selectedTurn
    ? { kind: "turn", runId: selectedTurn.runId }
    : selectedCommitSha
      ? { kind: "commit", sha: selectedCommitSha }
      : { kind: selectedGitScope };
  const scopeMenuTurns = useMemo<ReadonlyArray<DiffScopeMenuTurn>>(
    () =>
      orderedTurnDiffSummaries.map((summary) => ({
        runId: summary.runId,
        turnCount: summary.checkpointTurnCount ?? inferredCheckpointTurnCountByRunId[summary.runId],
        fileCount: summary.files.length,
        completedAt: summary.completedAt,
      })),
    [inferredCheckpointTurnCountByRunId, orderedTurnDiffSummaries],
  );
  const selectedCommit = selectedCommitSha
    ? branchCommits.data?.commits.find((commit) => commit.sha === selectedCommitSha)
    : undefined;
  const scopeMenuLabel = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
    : selectedCommitSha
      ? selectedCommitSha.slice(0, 7)
      : selectedGitScope === "unstaged"
        ? "Uncommitted"
        : "All changes";
  const scopeMenuTitle = selectedCommit?.subject || selectedScopeLabel;
  // What the comparison resolves to: the server's answer when it gave one, else the pick.
  const resolvedBaseRef =
    branchCommits.data?.baseRef ??
    (selectedGitSource?.kind === "branch-range" || selectedGitSource?.kind === "all"
      ? selectedGitSource.baseRef
      : null) ??
    commitsBaseRef;
  const previewCwd = branchDiffPreview.data?.cwd ?? activeCwd;

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1 [-webkit-app-region:no-drag]">
        {routeThreadRef && activeThread && isGitRepo ? (
          <div className="me-1 flex min-w-0 shrink items-center">
            <DiffScopeMenu
              selected={selectedScopeChoice}
              label={scopeMenuLabel}
              title={scopeMenuTitle}
              uncommittedFileCount={gitStatusQuery.data?.workingTree.files.length ?? null}
              commits={branchCommits.data?.commits ?? []}
              commitsTruncated={branchCommits.data?.truncated ?? false}
              turns={scopeMenuTurns}
              onSelect={selectScope}
              targetBranchPicker={
                previewCwd && !selectedTurn ? (
                  <DiffTargetBranchPicker
                    environmentId={activeThread.environmentId}
                    cwd={previewCwd}
                    selectedBaseRef={commitsBaseRef}
                    resolvedBaseRef={resolvedBaseRef}
                    headRef={gitStatusQuery.data?.refName ?? selectedGitSource?.headRef ?? null}
                    onSelect={(baseRef) =>
                      useDiffPanelStore.getState().setBaseRef(routeThreadRef, baseRef)
                    }
                  />
                ) : null
              }
            />
          </div>
        ) : null}
        {singleFileEntry && orderedFileEntries.length > 0 ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Previous file"
                    disabled={singleFilePosition <= 0}
                    onClick={() => stepOpenFile(-1)}
                  />
                }
              >
                <ChevronUpIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Previous file</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Next file"
                    disabled={singleFilePosition >= orderedFileEntries.length - 1}
                    onClick={() => stepOpenFile(1)}
                  />
                }
              >
                <ChevronDownIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Next file</TooltipPopup>
            </Tooltip>
            <span className="ms-1 shrink-0 text-xs tabular-nums text-muted-foreground">
              {singleFilePosition + 1} / {orderedFileEntries.length}
            </span>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {codeViewFiles.length > 0 || (!selectedTurn && selectedGitSource?.files?.length) ? (
          <DiffStatLabel
            additions={diffLineStat.additions}
            deletions={diffLineStat.deletions}
            className="mr-1 text-2xs"
            layout="inline"
          />
        ) : null}
        {canRefreshGitDiff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={isRefreshingDiff ? "Refreshing diff" : "Refresh diff"}
                  onClick={refreshDiffFromUserAction}
                />
              }
            >
              <RefreshIcon size="sm" refreshing={isRefreshingDiff} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {isRefreshingDiff ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        {diffFileKeys.length > 0 && !fileTreeOpen && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={toggleDiffFileCollapse}
                />
              }
            >
              {allDiffFilesCollapsed ? (
                <ChevronsUpDownIcon className="size-3.5" />
              ) : (
                <ChevronsDownUpIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        )}
        <ToggleGroup
          aria-label="Diff layout"
          className="shrink-0"
          variant="segmented"
          value={[diffViewMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "file") {
              setExpandUnchanged(true);
            } else if (next === "stacked" || next === "split") {
              setExpandUnchanged(false);
              updateClientSettings({ diffLayout: next });
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3.5" />
          </Toggle>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle aria-label="Full file view" value="file" disabled={!canExpandUnchanged} />
              }
            >
              <FileTextIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {canExpandUnchanged ? "Full file" : "Full files are unavailable for turn diffs"}
            </TooltipPopup>
          </Tooltip>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrap(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="ghost"
                size="sm"
                pressed={diffIgnoreWhitespace}
                onPressedChange={(pressed) => {
                  setDiffIgnoreWhitespace(Boolean(pressed));
                }}
              />
            }
          >
            <PilcrowIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
        {diffFileKeys.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                  variant="ghost"
                  size="sm"
                  pressed={fileTreeOpen}
                  onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
                />
              }
            >
              <FolderTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {fileTreeOpen ? "Hide file tree" : "Show file tree"}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedRunId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            {isSelectedPatchTruncated && !lazySource && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                This preview exceeds the size limit. Changes shown are incomplete.
                {selectedGitSource?.files ? " Totals include all changes." : ""}
              </p>
            )}
            {selectedPatchError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-2xs text-error/80">{selectedPatchError}</p>
              </div>
            )}
            {!renderablePatch && !lazySource ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={
                    selectedTurn
                      ? "Loading checkpoint diff..."
                      : selectedGitScope === "unstaged"
                        ? "Loading working tree diff..."
                        : "Loading branch diff..."
                  }
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-4 px-5 text-center">
                  <GitCompareArrowsIcon
                    className="size-8 text-muted-foreground/50"
                    strokeWidth={1.5}
                  />
                  <p className="text-sm text-muted-foreground">
                    {!hasNoNetChanges
                      ? "No patch available for this selection."
                      : selectedTurn
                        ? "No changes in this turn"
                        : selectedCommitSha
                          ? "This commit has no file changes"
                          : selectedGitScope === "unstaged"
                            ? "No uncommitted changes yet"
                            : "No changes yet"}
                  </p>
                </div>
              )
            ) : lazySource || renderablePatch?.kind === "files" ? (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                {activeThread && activeCwd ? (
                  <DiffCodeIntelligence
                    root={codeSurfaceRef}
                    environmentId={activeThread.environmentId}
                    cwd={activeCwd}
                    repositoryRoot={activeRepositoryRoot}
                    files={codeViewFiles}
                    loadDiffFiles={currentLoadDiffFiles}
                    onOpenLocation={openCodeLocation}
                  />
                ) : null}
                <div
                  ref={codeSurfaceRef}
                  className="min-h-0 min-w-0 flex-1"
                  onClickCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    for (const node of composedPath) {
                      if (!(node instanceof HTMLElement)) continue;
                      // Header controls keep their own actions. In particular, the chevron must
                      // not also trigger the row handler or the two toggles cancel each other.
                      if (
                        node instanceof HTMLButtonElement ||
                        node instanceof HTMLAnchorElement ||
                        node instanceof HTMLLabelElement
                      ) {
                        return;
                      }
                    }
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent;
                    // The filename remains the explicit "open in editor" affordance.
                    if (filePath) {
                      openDiffFile(filePath);
                      return;
                    }
                    const header = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                    );
                    const headerFilePath = header?.querySelector("[data-title]")?.textContent;
                    if (!headerFilePath) return;
                    const file = codeViewFiles.find(
                      (candidate) => candidate.filePath === headerFilePath,
                    );
                    if (file) toggleDiffFileCollapsed(file.fileKey);
                  }}
                  onContextMenuCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent?.trim();
                    if (!filePath) return;
                    event.preventDefault();
                    onFileContextMenu(
                      {
                        environmentId: activeThread?.environmentId ?? null,
                        filePath,
                        workspaceRoot: activeCwd,
                        repositoryRoot: activeRepositoryRoot,
                      },
                      event,
                    );
                  }}
                >
                  {singleFileEntry && !singleFileReady ? (
                    <DiffPanelLoadingState label="Loading file diff..." />
                  ) : null}
                  <AnnotatableCodeView
                    key={collapseScopeKey ?? reviewSectionId}
                    viewerRef={setCodeView}
                    codeViewKey={`${codeViewMountKey}:${lazySource ? filePatchScope : "preview"}:${singleFilePath ?? "all"}`}
                    className={
                      singleFileEntry && !singleFileReady
                        ? "hidden"
                        : "h-full min-h-0 overflow-auto"
                    }
                    files={codeViewFiles}
                    {...(singleFileEntry ? {} : { renderCodeViewFooter: renderLoadingBoundary })}
                    sectionId={reviewSectionId}
                    sectionTitle={reviewSectionTitle}
                    composerDraftTarget={composerDraftTarget}
                    renderHeaderFilenameSuffix={(fileDiff) => {
                      const path = resolveFileDiffPath(fileDiff);
                      const stat = fileStats.get(path);
                      return (
                        <>
                          <DiffFilePathCopyButton filePath={path} />
                          {stat ? (
                            <DiffFileStatus {...fileStates.get(path)} retry={() => retry(path)} />
                          ) : null}
                        </>
                      );
                    }}
                    {...(lazySource
                      ? {
                          unsafeCSSExtra:
                            "[data-additions-count], [data-deletions-count] { display: none; }",
                        }
                      : {})}
                    renderHeaderMetadata={(fileDiff) => {
                      const stat = lazySource
                        ? fileStats.get(resolveFileDiffPath(fileDiff))
                        : undefined;
                      const { fileKey } = getCachedFileEntry(fileDiff);
                      const changed = viewedFiles.changedKeys.has(fileKey);
                      return (
                        <span className="flex items-center gap-3">
                          {stat ? (
                            <DiffStatLabel additions={stat.additions} deletions={stat.deletions} />
                          ) : null}
                          {/* The header itself folds the file, so the tick keeps its press to
                              itself; the capture listener above skips labels. */}
                          {routeThreadRef ? (
                            <label
                              className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <Checkbox
                                aria-label={changed ? "Changed" : "Viewed"}
                                checked={viewedFiles.keys.has(fileKey)}
                                onCheckedChange={() => toggleDiffFileViewed(fileDiff)}
                              />
                              {changed ? (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={<span className="text-warning-foreground" />}
                                  >
                                    Changed
                                  </TooltipTrigger>
                                  <TooltipPopup side="bottom">
                                    This file has changed since you marked it viewed.
                                  </TooltipPopup>
                                </Tooltip>
                              ) : (
                                "Viewed"
                              )}
                            </label>
                          ) : null}
                        </span>
                      );
                    }}
                    renderHeaderPrefix={(fileDiff, fileKey) => {
                      if (singleFileEntry) return null;
                      const unavailable = fileDiff.cacheKey?.endsWith(":pending") === true;
                      const collapsed = unavailable || collapsedDiffFileKeys.has(fileKey);
                      const filePath = resolveFileDiffPath(fileDiff);
                      return (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-micro"
                                variant="ghost"
                                className="-ms-0.5"
                                aria-label={
                                  collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`
                                }
                                aria-expanded={!collapsed}
                                disabled={unavailable}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleDiffFileCollapsed(fileKey);
                                }}
                              />
                            }
                          >
                            {collapsed ? (
                              <ChevronRightIcon
                                className={cn("size-4", getDiffCollapseIconClassName(fileDiff))}
                              />
                            ) : (
                              <ChevronDownIcon
                                className={cn("size-4", getDiffCollapseIconClassName(fileDiff))}
                              />
                            )}
                          </TooltipTrigger>
                          <TooltipPopup side="top">
                            {collapsed ? "Expand diff" : "Collapse diff"}
                          </TooltipPopup>
                        </Tooltip>
                      );
                    }}
                    options={{
                      diffStyle: diffViewMode === "split" ? "split" : "unified",
                      expandUnchanged: diffViewMode === "file",
                      lineDiffType: "none",
                      overflow: wordWrap ? "wrap" : "scroll",
                      theme: resolveDiffThemeName(resolvedTheme),
                      preferredHighlighter: PREFERRED_HIGHLIGHTER,
                      themeType: resolvedTheme as DiffThemeType,
                      stickyHeaders: true,
                      ...(currentLoadDiffFiles ? { loadDiffFiles } : {}),
                    }}
                  />
                </div>
                {fileTreeOpen ? (
                  <aside
                    className="relative flex min-w-0 shrink-0 flex-col border-l border-border/60"
                    style={{ width: fileTreeWidth }}
                  >
                    <RightPanelResizeHandle handlers={fileTreeResizeHandlers} />
                    <div className="flex h-8 shrink-0 items-center gap-2 px-2.5">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                        {treeFiles.length} {treeFiles.length === 1 ? "file" : "files"}
                      </span>
                      {viewedFiles.paths.size > 0 ? (
                        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                          {viewedFiles.paths.size}/{treeFiles.length} viewed
                        </span>
                      ) : (
                        <DiffStatLabel
                          additions={diffLineStat.additions}
                          deletions={diffLineStat.deletions}
                          layout="inline"
                          className="shrink-0 text-2xs"
                        />
                      )}
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <DiffChangesTree
                        files={treeFiles}
                        selectedPath={singleFilePath}
                        ariaLabel={`${reviewSectionTitle} files`}
                        actions={{
                          onOpenFile: revealDiffFile,
                          onOpenInFiles: openDiffFile,
                          onCopyPath: (path) => copyToClipboard(path, undefined),
                        }}
                      />
                    </div>
                  </aside>
                ) : null}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-2xs text-muted-foreground/75">
                    {renderablePatch?.kind === "raw" ? renderablePatch.reason : null}
                  </p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-2xs leading-relaxed text-muted-foreground/90",
                      wordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch?.kind === "raw" ? renderablePatch.text : null}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
