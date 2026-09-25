import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type {
  CodeDiagnostic,
  CodeLocation,
  EnvironmentId,
  LanguageRequest,
  LanguageResult,
} from "@t3tools/contracts";
import { getFiletypeFromFileName } from "@pierre/diffs";
import type { Editor } from "@pierre/diffs/editor";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { isMacPlatform } from "~/lib/utils";
import { CodeLanguageSession } from "./codeLanguageSession";
import {
  afterInsertedText,
  completionChoices,
  completionEdit,
  editorPosition,
  editorRange,
  languagePosition,
  wordAtLine,
  type CodePosition,
  type Completion,
} from "./codeIntelligenceEdits";
import {
  fileDomRange,
  filePositionAtPoint,
  fileShadow,
  popupPosition,
  type PopupAnchor,
} from "./fileCodeDom";
import {
  CODE_POPUP_CLASS,
  CodeInfoCard,
  CodeLocationList,
  CompletionKindIcon,
  CompletionLabel,
  ProblemLine,
  codePopupStyle,
  diagnosticLabel,
  type CodeInfo,
} from "./codeIntelligencePopups";
import { Button } from "~/components/ui/button";
import { diagnosticsAt } from "./codeIntelligenceEdits";

export interface FileCodeNavigation {
  workspaceMutationId: string | null;
  reveal: { line: number; column: number; id: number } | null;
  onNavigate: (target: CodeLocation, source: CodeLocation) => void;
  onBack: (() => void) | undefined;
  onForward: (() => void) | undefined;
}

type FileEditor = Pick<
  Editor<unknown>,
  "getFile" | "getText" | "getState" | "setSelections" | "applyEdits" | "setMarkers" | "focus"
>;
interface Props extends FileCodeNavigation {
  editor: FileEditor;
  root: RefObject<HTMLDivElement | null>;
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  contents: string;
}
type Suggestions = {
  items: ReadonlyArray<Completion>;
  selected: number;
  position: CodePosition;
  text: string;
  prefix: string;
  anchor: PopupAnchor;
};
export default function FileCodeIntelligence(props: Props) {
  const { editor, root, environmentId, cwd, relativePath } = props;
  const current = useRef(props);
  useEffect(() => {
    current.current = props;
  });
  const listId = useId();
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [info, setInfo] = useState<CodeInfo | null>(null);
  const [links, setLinks] = useState<ReadonlyArray<DOMRect>>([]);
  const [diagnostics, setDiagnostics] = useState<ReadonlyArray<CodeDiagnostic>>([]);
  const [checking, setChecking] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"problems" | "locations" | null>(null);
  const [locations, setLocations] = useState<{ title: string; items: ReadonlyArray<CodeLocation> }>(
    { title: "References", items: [] },
  );
  const command = useAtomCommand(projectEnvironment.language, { reportFailure: false });
  const actions = useRef<{
    changed: () => void;
    diagnostics: (reload?: boolean) => void;
    navigate: (operation: "definition" | "references", position?: CodePosition) => void;
    format: () => void;
    accept: (index: number) => void;
    reveal: (position: CodePosition) => void;
  } | null>(null);

  useEffect(() => {
    const surface = root.current;
    if (!surface) return;
    let disposed = false;
    let document = { contents: editor.getText(), version: 1 };
    let lines = document.contents.split("\n");
    let suggestion: Suggestions | null = null;
    let problems: ReadonlyArray<CodeDiagnostic> = [];
    let suggestionSequence = 0;
    let hoverSequence = 0;
    let signatureSequence = 0;
    let typing = false;
    let composing = false;
    let signatureVisible = false;
    let diagnosticsTimer: ReturnType<typeof setTimeout> | undefined;
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    let cursorFrame = 0;
    let hoverKey = "";
    let linkContent: HTMLElement | null = null;
    let previousCursor = "";
    let pointer: { x: number; y: number } | null = null;
    const mac = isMacPlatform(navigator.platform);
    const modified = (event: { metaKey: boolean; ctrlKey: boolean }) =>
      mac ? event.metaKey : event.ctrlKey;
    const session = new CodeLanguageSession({ cwd, relativePath }, async (input) => {
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    });
    const snapshot = () => {
      const contents = editor.getText();
      if (contents !== document.contents) {
        document = { contents, version: document.version + 1 };
        lines = contents.split("\n");
      }
      return document;
    };
    const cursor = () => {
      const selection = editor.getState().selections?.at(-1);
      return selection
        ? languagePosition(selection.direction === -1 ? selection.start : selection.end)
        : undefined;
    };
    const atCursor = (position: CodePosition) => {
      const now = cursor();
      return now?.line === position.line && now.column === position.column;
    };
    const query = async (
      operation: LanguageRequest["operation"],
      position?: CodePosition,
      cancelled = () => false,
    ): Promise<LanguageResult | undefined> => {
      const state = snapshot();
      const stale = () => disposed || editor.getText() !== state.contents || cancelled();
      try {
        const result = await session.request(state, operation, position, stale);
        if (stale()) return;
        if (result) {
          setReady(true);
          setError(null);
        }
        return result;
      } catch (cause) {
        if (!stale())
          setError(
            cause instanceof Error
              ? cause.message
              : "Language features are unavailable. Retry to reconnect.",
          );
      }
    };
    const updateSuggestions = (value: Suggestions | null) => {
      suggestion = value;
      setSuggestions(value);
    };
    const clearHover = () => {
      clearTimeout(hoverTimer);
      hoverSequence++;
      hoverKey = "";
      setLinks([]);
      if (linkContent) linkContent.style.cursor = previousCursor;
      linkContent = null;
      setInfo(null);
    };
    const dismiss = () => {
      clearTimeout(completionTimer);
      suggestionSequence++;
      signatureSequence++;
      signatureVisible = false;
      updateSuggestions(null);
      clearHover();
    };
    const reveal = (position: CodePosition) => {
      const point = editorPosition(position);
      editor.setSelections([{ start: point, end: point, direction: "none" }]);
      editor.focus();
    };
    const navigate = async (operation: "definition" | "references", position = cursor()) => {
      if (!position) return;
      dismiss();
      const result = await query(operation, position);
      if (result?._tag !== "locations") return;
      if (operation === "definition" && result.items.length === 1) {
        current.current.onNavigate(result.items[0]!, {
          path: relativePath,
          range: { start: position, end: position },
        });
      } else {
        setLocations({
          title: operation === "definition" ? "Definitions" : "References",
          items: result.items,
        });
        setPanel("locations");
      }
    };
    const checkDiagnostics = async (reload = false) => {
      const text = editor.getText();
      setChecking(true);
      const result = await query(reload ? "refresh" : "diagnostics");
      if (disposed || editor.getText() !== text) return;
      setChecking(false);
      if (result?._tag !== "diagnostics") return;
      problems = result.items;
      setDiagnostics(result.items);
      editor.setMarkers(
        result.items.map((item) => ({
          ...editorRange(item.range),
          message: item.message,
          source: diagnosticLabel(item),
          severity:
            item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : "info",
        })),
      );
    };
    const showSuggestions = async () => {
      const position = cursor();
      if (!position || composing) return;
      const sequence = ++suggestionSequence;
      const text = editor.getText();
      const result = await query(
        "completions",
        position,
        () => sequence !== suggestionSequence || !atCursor(position),
      );
      if (result?._tag !== "completions") return;
      const rect = fileDomRange(surface, position)?.getBoundingClientRect();
      if (!rect) return;
      const prefix = wordAtLine(lines[position.line - 1] ?? "", position).prefix;
      const items = completionChoices(result.items, prefix);
      updateSuggestions(
        items.length
          ? { items, selected: 0, position, text, prefix, anchor: popupPosition(rect) }
          : null,
      );
    };
    const showSignature = async () => {
      const position = cursor();
      if (!position) return;
      const sequence = ++signatureSequence;
      const result = await query(
        "signature",
        position,
        () => sequence !== signatureSequence || !atCursor(position),
      );
      if (result?._tag !== "signature") return;
      const item = result.items[result.activeSignature];
      const rect = fileDomRange(surface, position)?.getBoundingClientRect();
      signatureVisible = !!item;
      setInfo(
        item && rect
          ? {
              display: item.label,
              documentation: item.documentation,
              parameter: item.parameters[result.activeParameter]?.label ?? "",
              anchor: popupPosition(rect, 140, true),
            }
          : null,
      );
    };
    const accept = (index: number) => {
      const value = suggestion;
      const item = value?.items[index];
      if (!value || !item || editor.getText() !== value.text || !atCursor(value.position)) return;
      const edit = completionEdit(item, value.text, value.position);
      dismiss();
      typing = false;
      editor.applyEdits([edit]);
      reveal(languagePosition(afterInsertedText(edit.range.start, edit.newText)));
    };
    const format = async () => {
      dismiss();
      const result = await query("format");
      if (result?._tag !== "format" || result.edits.length === 0) return;
      typing = false;
      editor.applyEdits(
        result.edits.map((edit) => ({ range: editorRange(edit.range), newText: edit.text })),
      );
      editor.focus();
    };
    const changed = () => {
      snapshot();
      if (editor.getFile()) editor.setMarkers([]);
      problems = [];
      setDiagnostics([]);
      setChecking(true);
      setLocations({ title: "References", items: [] });
      clearTimeout(diagnosticsTimer);
      diagnosticsTimer = setTimeout(() => {
        void checkDiagnostics();
      }, 600);
      suggestionSequence++;
      updateSuggestions(null);
      clearHover();
      clearTimeout(completionTimer);
      if (typing && !composing) {
        const position = cursor();
        const before = position
          ? (lines[position.line - 1] ?? "").slice(0, position.column - 1)
          : "";
        if (/[\p{ID_Continue}$.:"']$/u.test(before))
          completionTimer = setTimeout(() => {
            void showSuggestions();
          }, 120);
        if (/[(),]$/.test(before) || signatureVisible) void showSignature();
      }
      typing = false;
    };
    const hoverAtPointer = (commandHeld: boolean) => {
      if (!pointer || composing || suggestion) return;
      const position = filePositionAtPoint(surface, pointer.x, pointer.y);
      if (!position) {
        clearHover();
        return;
      }
      snapshot();
      const word = wordAtLine(lines[position.line - 1] ?? "", position);
      const key = `${position.line}:${word.range.start.column}:${commandHeld}`;
      if (hoverKey === key) return;
      clearHover();
      if (!word.text) return;
      hoverKey = key;
      const sequence = hoverSequence;
      hoverTimer = setTimeout(
        () => {
          void query(
            commandHeld ? "definition" : "hover",
            position,
            () => sequence !== hoverSequence,
          ).then((result) => {
            const range = fileDomRange(surface, word.range.start, word.range.end);
            if (!range || !result) return;
            if (result._tag === "locations" && result.items.length) {
              setLinks([...range.getClientRects()].filter((rect) => rect.width > 0));
              linkContent =
                fileShadow(surface)?.querySelector<HTMLElement>("[data-content]") ?? null;
              if (linkContent) {
                previousCursor = linkContent.style.cursor;
                linkContent.style.cursor = "pointer";
              }
            } else if (result._tag === "hover") {
              const found = diagnosticsAt(problems, position);
              if (!result.info && found.length === 0) return;
              setInfo({
                display: result.info?.display ?? "",
                documentation: result.info?.documentation ?? "",
                markdown: result.info?.markdown,
                problems: found,
                language: getFiletypeFromFileName(relativePath),
                anchor: popupPosition(range.getBoundingClientRect(), 140, true),
              });
            }
          });
        },
        commandHeld ? 0 : 300,
      );
    };
    const isContentEvent = (event: Event) =>
      event
        .composedPath()
        .some((node) => node instanceof HTMLElement && node.hasAttribute("data-content"));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || composing) return;
      if (event.key === "Meta" || event.key === "Control") hoverAtPointer(modified(event));
      if (!isContentEvent(event)) return;
      let handled = true;
      if (event.key === "Escape") {
        dismiss();
        setPanel(null);
      } else if (suggestion && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        updateSuggestions({
          ...suggestion,
          selected:
            (suggestion.selected + (event.key === "ArrowDown" ? 1 : suggestion.items.length - 1)) %
            suggestion.items.length,
        });
      } else if (suggestion && (event.key === "Enter" || event.key === "Tab"))
        accept(suggestion.selected);
      else if (event.ctrlKey && !event.shiftKey && event.code === "Space") void showSuggestions();
      else if (event.key === "F12") void navigate(event.shiftKey ? "references" : "definition");
      else if (modified(event) && event.shiftKey && event.code === "Space") void showSignature();
      else if (event.altKey && event.shiftKey && event.code === "KeyF") void format();
      else handled = false;
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
      ) {
        dismiss();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") clearHover();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!isContentEvent(event)) {
        pointer = null;
        clearHover();
        return;
      }
      pointer = { x: event.clientX, y: event.clientY };
      hoverAtPointer(modified(event));
    };
    const onPointerLeave = () => {
      pointer = null;
      clearHover();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!isContentEvent(event)) return;
      if (event.button === 0 && modified(event)) {
        const position = filePositionAtPoint(surface, event.clientX, event.clientY);
        if (position) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void navigate("definition", position);
        }
      } else dismiss();
    };
    const beforeInput = () => {
      typing = true;
    };
    const compositionStart = () => {
      composing = true;
      dismiss();
    };
    const compositionEnd = () => {
      composing = false;
      typing = true;
      cancelAnimationFrame(cursorFrame);
      cursorFrame = requestAnimationFrame(changed);
    };
    const onBlur = () => {
      dismiss();
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-file-code-popup]")) return;
      clearHover();
      updateSuggestions(null);
    };
    surface.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerleave", onPointerLeave);
    surface.addEventListener("pointerdown", onPointerDown, true);
    surface.addEventListener("beforeinput", beforeInput, true);
    surface.addEventListener("compositionstart", compositionStart, true);
    surface.addEventListener("compositionend", compositionEnd, true);
    surface.addEventListener("focusout", onBlur);
    surface.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    actions.current = {
      changed,
      diagnostics: (reload) => {
        void checkDiagnostics(reload);
      },
      navigate: (operation, position) => {
        void navigate(operation, position);
      },
      format: () => {
        void format();
      },
      accept,
      reveal,
    };
    void checkDiagnostics();
    return () => {
      disposed = true;
      clearTimeout(diagnosticsTimer);
      clearTimeout(completionTimer);
      clearTimeout(hoverTimer);
      cancelAnimationFrame(cursorFrame);
      actions.current = null;
      session.dispose();
      if (linkContent) linkContent.style.cursor = previousCursor;
      if (editor.getFile()) editor.setMarkers([]);
      surface.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerleave", onPointerLeave);
      surface.removeEventListener("pointerdown", onPointerDown, true);
      surface.removeEventListener("beforeinput", beforeInput, true);
      surface.removeEventListener("compositionstart", compositionStart, true);
      surface.removeEventListener("compositionend", compositionEnd, true);
      surface.removeEventListener("focusout", onBlur);
      surface.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [command, cwd, editor, environmentId, relativePath, root]);

  const previousContents = useRef(props.contents);
  useEffect(() => {
    if (previousContents.current === props.contents) return;
    previousContents.current = props.contents;
    actions.current?.changed();
  }, [props.contents]);
  const previousMutation = useRef(props.workspaceMutationId);
  useEffect(() => {
    if (previousMutation.current === props.workspaceMutationId) return;
    previousMutation.current = props.workspaceMutationId;
    actions.current?.diagnostics(true);
  }, [props.workspaceMutationId]);
  useEffect(() => {
    if (props.reveal) actions.current?.reveal(props.reveal);
  }, [props.reveal]);
  useEffect(() => {
    if (!suggestions || !root.current) return;
    const input = fileShadow(root.current)?.querySelector("[data-content]");
    input?.setAttribute("aria-controls", listId);
    input?.setAttribute("aria-autocomplete", "list");
    input?.setAttribute("aria-expanded", "true");
    input?.setAttribute("aria-activedescendant", `${listId}-${suggestions.selected}`);
    root.current
      .querySelector(`[id="${listId}-${suggestions.selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
    return () => {
      for (const name of [
        "aria-controls",
        "aria-autocomplete",
        "aria-expanded",
        "aria-activedescendant",
      ])
        input?.removeAttribute(name);
    };
  }, [listId, root, suggestions]);

  const toolbarAction = (label: string, title: string, onClick: () => void) => (
    <Button
      variant="ghost"
      size="xs"
      aria-label={title}
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  const selectLocation = (item: CodeLocation) => {
    const selection = editor.getState().selections?.at(-1);
    const point = selection
      ? languagePosition(selection.direction === -1 ? selection.start : selection.end)
      : { line: 1, column: 1 };
    props.onNavigate(item, { path: relativePath, range: { start: point, end: point } });
    setPanel(null);
  };

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Go back"
          disabled={!props.onBack}
          onClick={props.onBack}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Go forward"
          disabled={!props.onForward}
          onClick={props.onForward}
        >
          <ArrowRight />
        </Button>
        {toolbarAction("Definition", "Go to definition (F12)", () =>
          actions.current?.navigate("definition"),
        )}
        {toolbarAction("References", "Find references (Shift+F12)", () =>
          actions.current?.navigate("references"),
        )}
        {toolbarAction("Format", "Format document (Shift+Alt+F)", () => actions.current?.format())}
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          aria-pressed={panel === "problems"}
          onClick={() => setPanel(panel === "problems" ? null : "problems")}
        >
          {checking
            ? "Checking…"
            : `${diagnostics.length} ${diagnostics.length === 1 ? "problem" : "problems"}`}
        </Button>
        <span className="px-1 text-3xs text-muted-foreground" role="status">
          {error
            ? "Language features unavailable"
            : ready
              ? "IntelliSense ready"
              : "Starting IntelliSense…"}
        </span>
      </div>
      {error ? (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-destructive"
        >
          <span className="flex-1">{error}</span>
          <Button variant="outline" size="xs" onClick={() => actions.current?.diagnostics()}>
            Retry
          </Button>
        </div>
      ) : null}
      {suggestions ? (
        <div
          data-file-code-popup
          className={`${CODE_POPUP_CLASS} w-[420px]`}
          style={codePopupStyle(suggestions.anchor, 420)}
          onPointerDown={(event) => event.preventDefault()}
        >
          <div
            id={listId}
            role="listbox"
            aria-label="Code suggestions"
            className="max-h-[264px] overflow-auto font-mono text-xs"
          >
            {suggestions.items.map((item, index) => {
              const selected = index === suggestions.selected;
              return (
                <button
                  type="button"
                  key={`${item.label}:${item.kind}:${item.insertText}`}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  className={`flex h-[22px] w-full items-center gap-1.5 px-1.5 text-left ${selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
                  onClick={() => actions.current?.accept(index)}
                >
                  <CompletionKindIcon kind={item.kind} />
                  <CompletionLabel label={item.label} prefix={suggestions.prefix} />
                  {selected ? (
                    <span className="ml-auto shrink-0 pl-3 font-sans text-2xs text-muted-foreground">
                      {item.kind}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {info && !suggestions ? <CodeInfoCard info={info} /> : null}
      {links.map((rect) => (
        <span
          key={`${rect.x}:${rect.y}:${rect.width}:${rect.height}`}
          data-code-definition-link
          className="pointer-events-none fixed z-40 border-b border-current text-primary"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      ))}
      {panel ? (
        <div className="max-h-48 shrink-0 overflow-auto border-b border-border/60 text-xs">
          <div className="sticky top-0 z-10 flex items-center justify-between bg-background px-3 py-1">
            <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {panel === "problems" ? "Problems" : locations.title}
              <span className="rounded-full bg-muted px-1.5 text-3xs tabular-nums">
                {panel === "problems" ? diagnostics.length : locations.items.length}
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close results"
              onClick={() => setPanel(null)}
            >
              <X />
            </Button>
          </div>
          {panel === "problems" ? (
            diagnostics.length === 0 ? (
              <p className="px-3 pb-3 text-muted-foreground">
                {checking
                  ? "Checking this file…"
                  : error
                    ? "Unable to check this file."
                    : "No problems in this file."}
              </p>
            ) : (
              diagnostics
                .toSorted(
                  (a, b) =>
                    a.range.start.line - b.range.start.line ||
                    a.range.start.column - b.range.start.column,
                )
                .map((item) => (
                  <button
                    type="button"
                    key={JSON.stringify(item)}
                    className="block w-full px-3 py-0.5 text-left hover:bg-accent"
                    onClick={() => actions.current?.reveal(item.range.start)}
                  >
                    <ProblemLine item={item} position />
                  </button>
                ))
            )
          ) : (
            <CodeLocationList
              items={locations.items}
              emptyText={`No ${locations.title.toLowerCase()} found at the cursor.`}
              onSelect={selectLocation}
            />
          )}
        </div>
      ) : null}
    </>
  );
}
