import {
  getFiletypeFromFileName,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
} from "@pierre/diffs";
import {
  codeLanguageForPath,
  type CodeDiagnostic,
  type CodeLocation,
  type EnvironmentId,
  type LanguageRequest,
  type LanguageResult,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { Button } from "~/components/ui/button";
import { resolveDiffPathForWorkspace } from "~/diffFileActions";
import { isMacPlatform } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { diagnosticsAt, wordAtLine, type CodePosition } from "../files/codeIntelligenceEdits";
import {
  CODE_POPUP_CLASS,
  CodeInfoAction,
  CodeInfoCard,
  CodeLocationList,
  codePopupStyle,
  type CodeInfo,
} from "../files/codeIntelligencePopups";
import { CodeLanguageSession } from "../files/codeLanguageSession";
import {
  codeLineAtPoint,
  lineTextRange,
  popupPosition,
  type PopupAnchor,
} from "../files/fileCodeDom";
import {
  diagnosticLineSpans,
  diffLineMatches,
  diffNewSideText,
} from "./diffCodeIntelligence.logic";

/** Names shared with the `::highlight()` rules in StyledDiffCodeView's shadow-root CSS. */
const DIFF_CODE_HIGHLIGHTS = {
  error: "diff-code-problem-error",
  warning: "diff-code-problem-warning",
  link: "diff-code-definition-link",
} as const;

interface DiffCodeFile {
  fileDiff: FileDiffMetadata;
  filePath: string;
}

interface Props {
  /** The element that contains the code view's `diffs-container` hosts. */
  root: RefObject<HTMLElement | null>;
  environmentId: EnvironmentId;
  cwd: string;
  repositoryRoot: string | undefined;
  files: ReadonlyArray<DiffCodeFile>;
  loadDiffFiles: FileDiffContentsLoader | undefined;
  onOpenLocation: (path: string, line: number) => void;
}

interface AnalyzedFile {
  target: { cwd: string; relativePath: string };
  contents: string;
  version: number;
}

interface Hit {
  file: DiffCodeFile;
  element: HTMLElement;
  position: CodePosition;
  word: ReturnType<typeof wordAtLine>;
}

const supportsHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS;

function setHighlight(name: string, ranges: ReadonlyArray<Range>) {
  if (!supportsHighlights()) return;
  if (ranges.length === 0) CSS.highlights.delete(name);
  else CSS.highlights.set(name, new Highlight(...ranges));
}

/**
 * Read-only code intelligence for the new side of a diff: hover documentation, problem
 * underlines, and definition/reference navigation into the Files panel. Deleted lines
 * have no file to analyze, so they are skipped.
 */
export function DiffCodeIntelligence(props: Props) {
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const [info, setInfo] = useState<CodeInfo | null>(null);
  const [locations, setLocations] = useState<{
    title: string;
    items: ReadonlyArray<CodeLocation>;
    anchor: PopupAnchor;
  } | null>(null);
  const command = useAtomCommand(projectEnvironment.language, { reportFailure: false });
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    refresh: true,
  });
  const actions = useRef<{
    navigate: (operation: "definition" | "references") => void;
    cardHover: (hovered: boolean) => void;
    dismiss: () => void;
  } | null>(null);
  const { root: rootRef, environmentId, cwd } = props;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let disposed = false;
    let version = 0;
    const session = new CodeLanguageSession({ cwd, relativePath: "." }, async (input) => {
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    });
    // Keyed by the diff metadata object: a refreshed diff arrives as new objects.
    const documents = new WeakMap<FileDiffMetadata, Promise<AnalyzedFile | null>>();
    const resolved = new WeakMap<FileDiffMetadata, AnalyzedFile>();
    const problems = new WeakMap<AnalyzedFile, ReadonlyArray<CodeDiagnostic>>();
    const checking = new WeakSet<AnalyzedFile>();

    const documentFor = (file: DiffCodeFile) => {
      let document = documents.get(file.fileDiff);
      if (!document) {
        document = (async () => {
          const { repositoryRoot, loadDiffFiles } = latest.current;
          const relativePath = resolveDiffPathForWorkspace({
            filePath: file.filePath,
            workspaceRoot: cwd,
            repositoryRoot,
          });
          if (!relativePath || !codeLanguageForPath(relativePath)) return null;
          let contents = diffNewSideText(file.fileDiff);
          if (contents === null && loadDiffFiles) {
            contents = await loadDiffFiles(file.fileDiff).then(
              (loaded) => loaded.newFile?.contents ?? null,
              () => null,
            );
          }
          if (contents === null) {
            // Turn diffs carry patches only. The disk copy is checked line by line before use.
            const read = await readFile({ environmentId, input: { cwd, relativePath } });
            if (read._tag === "Success" && !read.value.truncated) contents = read.value.contents;
          }
          if (contents === null) return null;
          const analyzed = { target: { cwd, relativePath }, contents, version: ++version };
          resolved.set(file.fileDiff, analyzed);
          return analyzed;
        })();
        documents.set(file.fileDiff, document);
      }
      return document;
    };

    const fileForShadow = (shadow: ShadowRoot) => {
      const title = shadow.querySelector("[data-diffs-header] [data-title]")?.textContent?.trim();
      return title ? latest.current.files.find((file) => file.filePath === title) : undefined;
    };
    /** New-side line elements of one file; split view renders deletions in their own column. */
    const newSideLines = (shadow: ShadowRoot) => {
      const lines = new Map<number, HTMLElement>();
      for (const element of shadow.querySelectorAll<HTMLElement>(
        "code:not([data-deletions]) [data-content] [data-line]",
      )) {
        if (element.dataset.lineType === "change-deletion") continue;
        lines.set(Number(element.dataset.line), element);
      }
      return lines;
    };
    const hitAt = (x: number, y: number, path: ReadonlyArray<EventTarget>): Hit | undefined => {
      const host = path.find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.tagName === "DIFFS-CONTAINER",
      );
      const shadow = host?.shadowRoot;
      if (!shadow) return;
      const hit = codeLineAtPoint(shadow, x, y);
      if (!hit || hit.element.dataset.lineType === "change-deletion") return;
      if (hit.element.closest("[data-deletions]")) return;
      const file = fileForShadow(shadow);
      if (!file) return;
      const position = { line: Number(hit.element.dataset.line), column: hit.column };
      // Punctuation has no symbol to query but can still carry a problem.
      return {
        file,
        element: hit.element,
        position,
        word: wordAtLine(hit.element.textContent ?? "", position),
      };
    };

    const query = async (
      hit: Hit,
      operation: LanguageRequest["operation"],
      cancelled = () => false,
    ): Promise<LanguageResult | undefined> => {
      const document = await documentFor(hit.file);
      if (!document || disposed || cancelled()) return;
      if (!diffLineMatches(document.contents, hit.position.line, hit.element.textContent ?? ""))
        return;
      return session.request(document, operation, hit.position, () => disposed || cancelled());
    };

    let painting = 0;
    const paint = () => {
      cancelAnimationFrame(painting);
      painting = requestAnimationFrame(() => {
        if (disposed) return;
        const errors: Range[] = [];
        const warnings: Range[] = [];
        for (const host of root.querySelectorAll("diffs-container")) {
          const shadow = host.shadowRoot;
          const file = shadow ? fileForShadow(shadow) : undefined;
          const document = file ? resolved.get(file.fileDiff) : undefined;
          const items = document ? problems.get(document) : undefined;
          if (!shadow || !document || !items?.length) continue;
          const lines = newSideLines(shadow);
          const length = (line: number) => {
            const text = lines.get(line)?.textContent;
            return text !== undefined && diffLineMatches(document.contents, line, text)
              ? text.replace(/\n$/, "").length
              : undefined;
          };
          for (const item of items) {
            if (item.severity !== "error" && item.severity !== "warning") continue;
            for (const span of diagnosticLineSpans(item, length)) {
              const element = lines.get(span.line)!;
              (item.severity === "error" ? errors : warnings).push(
                lineTextRange(element, span.start, element, span.end),
              );
            }
          }
        }
        setHighlight(DIFF_CODE_HIGHLIGHTS.error, errors);
        setHighlight(DIFF_CODE_HIGHLIGHTS.warning, warnings);
      });
    };

    /** Checks every rendered file once per diff revision; results are cached per file. */
    let checkTimer: ReturnType<typeof setTimeout> | undefined;
    const checkRenderedFiles = () => {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(async () => {
        for (const host of root.querySelectorAll("diffs-container")) {
          const shadow = host.shadowRoot;
          const file = shadow ? fileForShadow(shadow) : undefined;
          if (!file || disposed) continue;
          const document = await documentFor(file);
          if (!document || checking.has(document) || disposed) continue;
          checking.add(document);
          try {
            const result = await session.request(document, "diagnostics");
            if (result?._tag === "diagnostics") problems.set(document, result.items);
          } catch {
            // Hover reports an unavailable language service; underlines just stay absent.
          }
          paint();
        }
      }, 400);
    };

    const observers = new Map<ShadowRoot, MutationObserver>();
    const observeShadows = () => {
      for (const host of root.querySelectorAll("diffs-container")) {
        const shadow = host.shadowRoot;
        if (!shadow || observers.has(shadow)) continue;
        // Virtualized rows re-render as the user scrolls; re-anchor underlines to new nodes.
        const observer = new MutationObserver(() => {
          paint();
          checkRenderedFiles();
        });
        observer.observe(shadow, { childList: true, subtree: true });
        observers.set(shadow, observer);
      }
    };
    const rootObserver = new MutationObserver(() => {
      observeShadows();
      paint();
      checkRenderedFiles();
    });
    rootObserver.observe(root, { childList: true, subtree: true });
    observeShadows();
    checkRenderedFiles();

    const mac = isMacPlatform(navigator.platform);
    const modified = (event: { metaKey: boolean; ctrlKey: boolean }) =>
      mac ? event.metaKey : event.ctrlKey;
    let hovered: Hit | undefined;
    let hoverKey = "";
    let hoverSequence = 0;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    let cardHovered = false;
    let infoHit: Hit | undefined;
    let linkElement: HTMLElement | undefined;
    let linkCursor = "";

    const clearLink = () => {
      setHighlight(DIFF_CODE_HIGHLIGHTS.link, []);
      if (linkElement) linkElement.style.cursor = linkCursor;
      linkElement = undefined;
    };
    const clearHover = () => {
      clearTimeout(hoverTimer);
      clearTimeout(leaveTimer);
      hoverSequence++;
      hoverKey = "";
      infoHit = undefined;
      cardHovered = false;
      clearLink();
      setInfo(null);
    };
    const wordRect = (hit: Hit) =>
      lineTextRange(
        hit.element,
        hit.word.range.start.column,
        hit.element,
        Math.max(hit.word.range.end.column, hit.word.range.start.column + 1),
      ).getBoundingClientRect();
    const problemsAt = (hit: Hit) => {
      const document = resolved.get(hit.file.fileDiff);
      return diagnosticsAt((document && problems.get(document)) ?? [], hit.position);
    };

    const hover = (hit: Hit, definition: boolean) => {
      const key = hit.word.text
        ? `${hit.file.filePath}:${hit.position.line}:${hit.word.range.start.column}:${definition}`
        : `${hit.file.filePath}:${hit.position.line}:${hit.position.column}:problems`;
      clearTimeout(leaveTimer);
      if (key === hoverKey) return;
      clearHover();
      hoverKey = key;
      const sequence = hoverSequence;
      const cancelled = () => sequence !== hoverSequence;
      if (!hit.word.text) {
        hoverTimer = setTimeout(() => {
          const found = problemsAt(hit);
          if (found.length === 0 || cancelled() || !hit.element.isConnected) return;
          infoHit = undefined;
          setInfo({
            display: "",
            documentation: "",
            problems: found,
            anchor: popupPosition(wordRect(hit), 120, true),
          });
        }, 350);
        return;
      }
      hoverTimer = setTimeout(
        () => {
          void query(hit, definition ? "definition" : "hover", cancelled).then(
            (result) => {
              if (!result || cancelled() || !hit.element.isConnected) return;
              if (result._tag === "locations") {
                if (result.items.length === 0) return;
                setHighlight(DIFF_CODE_HIGHLIGHTS.link, [
                  lineTextRange(
                    hit.element,
                    hit.word.range.start.column,
                    hit.element,
                    hit.word.range.end.column,
                  ),
                ]);
                linkElement = hit.element;
                linkCursor = hit.element.style.cursor;
                hit.element.style.cursor = "pointer";
                return;
              }
              if (result._tag !== "hover") return;
              const found = problemsAt(hit);
              if (!result.info && found.length === 0) return;
              infoHit = hit;
              setInfo({
                display: result.info?.display ?? "",
                documentation: result.info?.documentation ?? "",
                markdown: result.info?.markdown,
                problems: found,
                language: getFiletypeFromFileName(hit.file.filePath),
                anchor: popupPosition(wordRect(hit), 180, true),
              });
            },
            (cause: unknown) => {
              if (cancelled() || definition) return;
              infoHit = undefined;
              setInfo({
                display: "",
                documentation:
                  cause instanceof Error ? cause.message : "Language features are unavailable.",
                anchor: popupPosition(wordRect(hit), 120, true),
              });
            },
          );
        },
        definition ? 0 : 350,
      );
    };

    const navigate = async (operation: "definition" | "references", hit = hovered ?? infoHit) => {
      if (!hit?.word.text) return;
      const anchor = popupPosition(wordRect(hit));
      clearHover();
      const result = await query(hit, operation).catch(() => undefined);
      if (result?._tag !== "locations" || disposed) return;
      if (operation === "definition" && result.items.length === 1) {
        const [item] = result.items;
        latest.current.onOpenLocation(item!.path, item!.range.start.line);
        return;
      }
      setLocations({
        title: operation === "definition" ? "Definitions" : "References",
        items: result.items,
        anchor,
      });
    };

    const isPopupEvent = (event: Event) =>
      event.target instanceof Element && event.target.closest("[data-file-code-popup]") !== null;
    const onPointerMove = (event: PointerEvent) => {
      const hit = hitAt(event.clientX, event.clientY, event.composedPath());
      hovered = hit;
      if (hit) {
        hover(hit, modified(event));
        return;
      }
      clearTimeout(hoverTimer);
      hoverSequence++;
      hoverKey = "";
      clearLink();
      clearTimeout(leaveTimer);
      // Leave time to move onto the card and use its actions.
      leaveTimer = setTimeout(() => {
        if (!cardHovered) clearHover();
      }, 250);
    };
    const onPointerLeave = () => {
      hovered = undefined;
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        if (!cardHovered) clearHover();
      }, 250);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !modified(event)) return;
      const hit = hitAt(event.clientX, event.clientY, event.composedPath());
      if (!hit?.word.text) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void navigate("definition", hit);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearHover();
        setLocations(null);
        return;
      }
      if (!hovered) return;
      if (event.key === "Meta" || event.key === "Control") {
        if (modified(event)) hover(hovered, true);
      } else if (event.key === "F12") {
        event.preventDefault();
        void navigate(event.shiftKey ? "references" : "definition");
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if ((event.key === "Meta" || event.key === "Control") && hovered) hover(hovered, false);
    };
    const onScroll = (event: Event) => {
      if (isPopupEvent(event)) return;
      clearHover();
      paint();
    };
    const onWindowPointerDown = (event: PointerEvent) => {
      if (!isPopupEvent(event)) setLocations(null);
    };
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerleave", onPointerLeave);
    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerdown", onWindowPointerDown, true);
    window.addEventListener("blur", clearHover);
    actions.current = {
      navigate: (operation) => void navigate(operation),
      cardHover: (value) => {
        cardHovered = value;
        clearTimeout(leaveTimer);
        if (!value)
          leaveTimer = setTimeout(() => {
            if (!cardHovered && !hovered) clearHover();
          }, 250);
      },
      dismiss: clearHover,
    };
    return () => {
      disposed = true;
      actions.current = null;
      clearTimeout(hoverTimer);
      clearTimeout(leaveTimer);
      clearTimeout(checkTimer);
      cancelAnimationFrame(painting);
      clearLink();
      rootObserver.disconnect();
      for (const observer of observers.values()) observer.disconnect();
      for (const name of Object.values(DIFF_CODE_HIGHLIGHTS)) setHighlight(name, []);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerleave", onPointerLeave);
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", onWindowPointerDown, true);
      window.removeEventListener("blur", clearHover);
      session.dispose();
      setInfo(null);
    };
  }, [command, cwd, environmentId, readFile, rootRef]);

  return (
    <>
      {info ? (
        <CodeInfoCard
          info={info}
          onPointerEnter={() => actions.current?.cardHover(true)}
          onPointerLeave={() => actions.current?.cardHover(false)}
          actions={
            info.display || info.documentation ? (
              <>
                <CodeInfoAction
                  label="Go to Definition"
                  shortcut="F12"
                  onClick={() => actions.current?.navigate("definition")}
                />
                <CodeInfoAction
                  label="Find References"
                  shortcut={isMacPlatform(navigator.platform) ? "⇧F12" : "Shift+F12"}
                  onClick={() => actions.current?.navigate("references")}
                />
              </>
            ) : undefined
          }
        />
      ) : null}
      {locations ? (
        <div
          data-file-code-popup
          className={`${CODE_POPUP_CLASS} w-[480px] text-xs`}
          style={codePopupStyle(locations.anchor, 480)}
        >
          <div className="flex items-center justify-between border-b border-border py-0.5 pr-1 pl-2">
            <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {locations.title}
              <span className="rounded-full bg-muted px-1.5 text-3xs tabular-nums">
                {locations.items.length}
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close results"
              onClick={() => setLocations(null)}
            >
              <X />
            </Button>
          </div>
          <div className="max-h-60 overflow-auto">
            <CodeLocationList
              items={locations.items}
              emptyText={`No ${locations.title.toLowerCase()} found.`}
              onSelect={(item) => {
                setLocations(null);
                latest.current.onOpenLocation(item.path, item.range.start.line);
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
