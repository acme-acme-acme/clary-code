import { getFiletypeFromFileName } from "@pierre/diffs";
import type { CodeDiagnostic, CodeLocation } from "@t3tools/contracts";
import {
  Box,
  Braces,
  CircleX,
  Component,
  FileText,
  Folder,
  Hash,
  Info,
  KeyRound,
  LetterText,
  ListTree,
  Plug,
  SquareDashed,
  TriangleAlert,
  Type,
  Variable,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { memo, Suspense, use, useMemo, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";

import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";

import { RenderErrorBoundary } from "../RenderErrorBoundary";
import type { PopupAnchor } from "./fileCodeDom";

export interface CodeInfo {
  display: string;
  documentation: string;
  markdown?: boolean | undefined;
  /** Signature help: the active parameter, emphasized inside `display`. */
  parameter?: string | undefined;
  problems?: ReadonlyArray<CodeDiagnostic> | undefined;
  /** Shiki language for `display` and unlabeled code in the documentation. */
  language?: string | undefined;
  anchor: PopupAnchor;
}

const POPUP_CLASS =
  "fixed z-50 overflow-hidden rounded-[4px] border border-border bg-popover text-popover-foreground shadow-md";

/** Widest a popup may grow from its anchor without leaving the window. */
const popupStyle = (anchor: PopupAnchor, width: number): CSSProperties => ({
  ...anchor,
  ...(anchor.bottom === undefined ? {} : { maxHeight: `calc(100vh - ${anchor.bottom + 8}px)` }),
  maxWidth: `min(${width}px, calc(100vw - ${anchor.left + 8}px))`,
});

/** VS Code's `source(code)` suffix, e.g. `ts(2322)` or `Pyright(reportAttributeAccessIssue)`. */
export function diagnosticLabel(item: CodeDiagnostic) {
  const source = item.source ?? "ts";
  return item.code === "" ? source : `${source}(${item.code})`;
}

function SeverityIcon(props: { severity: CodeDiagnostic["severity"] }) {
  const [Icon, color] =
    props.severity === "error"
      ? [CircleX, "text-destructive"]
      : props.severity === "warning"
        ? [TriangleAlert, "text-warning"]
        : [Info, "text-info"];
  return <Icon aria-hidden className={cn("mt-[3px] size-3.5 shrink-0", color)} />;
}

/** One problem: severity icon, message, and a muted source and position. */
export function ProblemLine(props: { item: CodeDiagnostic; position?: boolean }) {
  const { item } = props;
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <SeverityIcon severity={item.severity} />
      <span className="min-w-0 whitespace-pre-wrap break-words">
        {item.message}
        <span className="ml-1.5 text-muted-foreground">
          {diagnosticLabel(item)}
          {props.position ? ` [Ln ${item.range.start.line}, Col ${item.range.start.column}]` : null}
        </span>
      </span>
    </span>
  );
}

interface CodeToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

const tokenStyle = (token: CodeToken): CSSProperties => ({
  ...(token.color ? { color: token.color } : {}),
  ...((token.fontStyle ?? 0) & 1 ? { fontStyle: "italic" } : {}),
  ...((token.fontStyle ?? 0) & 2 ? { fontWeight: 600 } : {}),
});

function ShikiLines(props: { code: string; language: string }) {
  const { resolvedTheme } = useTheme();
  const highlighter = use(getSyntaxHighlighterPromise(props.language));
  const lines = useMemo(() => {
    try {
      return highlighter.codeToTokens(props.code, {
        lang: props.language,
        theme: resolveDiffThemeName(resolvedTheme),
      }).tokens;
    } catch {
      return null;
    }
  }, [highlighter, props.code, props.language, resolvedTheme]);
  if (!lines) return props.code;
  return lines.map((line, row) => (
    // Lines of a fixed snippet never reorder.
    // oxlint-disable-next-line react/no-array-index-key
    <span key={row}>
      {row > 0 ? "\n" : null}
      {line.map((token) => (
        <span key={token.offset} style={tokenStyle(token)}>
          {token.content}
        </span>
      ))}
    </span>
  ));
}

/** A code snippet colored like the editor, falling back to plain text while Shiki loads. */
const HighlightedCode = memo(function HighlightedCode(props: {
  code: string;
  language: string | undefined;
}) {
  if (!props.language) return props.code;
  return (
    <RenderErrorBoundary fallback={props.code}>
      <Suspense fallback={props.code}>
        <ShikiLines code={props.code} language={props.language} />
      </Suspense>
    </RenderErrorBoundary>
  );
});

/** Signature help renders plainly with the active parameter underlined, as in VS Code. */
function SignatureLabel(props: { label: string; parameter: string }) {
  const at = props.parameter ? props.label.indexOf(props.parameter) : -1;
  if (at < 0) return props.label;
  return (
    <>
      {props.label.slice(0, at)}
      <span className="font-semibold text-foreground underline underline-offset-2">
        {props.parameter}
      </span>
      {props.label.slice(at + props.parameter.length)}
    </>
  );
}

const CODE_TEXT = "font-mono text-[12px] leading-[18px]";

function markdownComponents(language: string | undefined): Components {
  return {
    pre: ({ children }) => (
      <pre className={cn(CODE_TEXT, "my-1 whitespace-pre-wrap break-words")}>{children}</pre>
    ),
    code: ({ className, children }) => {
      const fence = /language-(\S+)/.exec(className ?? "")?.[1];
      const text = String(children ?? "");
      // Fenced blocks end in a newline; inline code does not.
      if (fence || text.endsWith("\n"))
        return <HighlightedCode code={text.replace(/\n$/, "")} language={fence ?? language} />;
      return <code className="rounded-[3px] bg-muted px-1 font-mono text-[12px]">{children}</code>;
    },
    hr: () => <hr className="-mx-2 my-1.5 border-border" />,
    a: ({ children, href }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
        {children}
      </a>
    ),
    p: ({ children }) => <p className="my-1">{children}</p>,
    ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
  };
}

/** A footer link in a hover, like VS Code's "Go to Definition (F12)". */
export function CodeInfoAction(props: { label: string; shortcut?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="text-primary hover:underline focus-visible:underline focus-visible:outline-none"
      onClick={props.onClick}
    >
      {props.label}
      {props.shortcut ? (
        <span className="ml-1 text-muted-foreground">({props.shortcut})</span>
      ) : null}
    </button>
  );
}

/** Hover documentation, signature help, and problems under the pointer. */
export function CodeInfoCard(props: {
  info: CodeInfo;
  /** Diff hovers carry actions, so the pointer must be able to reach them. */
  actions?: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const { info } = props;
  const components = useMemo(() => markdownComponents(info.language), [info.language]);
  const sections: ReactNode[] = [];
  if (info.problems?.length)
    sections.push(
      <div key="problems" className="space-y-1 px-2 py-1.5">
        {info.problems.map((item) => (
          <ProblemLine
            key={`${item.range.start.line}:${item.range.start.column}:${item.code}:${item.message}`}
            item={item}
          />
        ))}
      </div>,
    );
  if (info.display)
    sections.push(
      <pre key="display" className={cn(CODE_TEXT, "whitespace-pre-wrap break-words px-2 py-1.5")}>
        {info.parameter !== undefined ? (
          <span className="text-muted-foreground">
            <SignatureLabel label={info.display} parameter={info.parameter} />
          </span>
        ) : (
          <HighlightedCode code={info.display} language={info.language} />
        )}
      </pre>,
    );
  if (info.documentation)
    sections.push(
      <div key="docs" className="whitespace-pre-wrap break-words px-2 py-1">
        {info.markdown ? (
          <div className="whitespace-normal">
            <ReactMarkdown skipHtml disallowedElements={["img"]} components={components}>
              {info.documentation}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="my-1">{info.documentation}</p>
        )}
      </div>,
    );
  return (
    <div
      data-file-code-popup
      role="tooltip"
      className={cn(
        POPUP_CLASS,
        "w-max text-[13px] leading-5",
        !props.actions && "pointer-events-none",
      )}
      style={popupStyle(info.anchor, 520)}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
    >
      <div className="max-h-[300px] divide-y divide-border overflow-auto">{sections}</div>
      {props.actions ? (
        <div className="flex items-center gap-3 border-t border-border bg-muted/40 px-2 py-0.5 text-xs">
          {props.actions}
        </div>
      ) : null}
    </div>
  );
}

const KIND_ICONS: Record<string, [LucideIcon, string]> = {};
const kindIcon = (kinds: ReadonlyArray<string>, icon: LucideIcon, color: string) => {
  for (const kind of kinds) KIND_ICONS[kind] = [icon, color];
};
// Kinds come from tsserver (`ScriptElementKind`) and LSP (`CompletionItemKind`); colors follow
// VS Code's symbol icons.
kindIcon(
  ["method", "function", "constructor", "construct", "local function", "call"],
  Box,
  "text-violet-500",
);
kindIcon(["property", "field", "getter", "setter", "accessor"], Wrench, "text-sky-500");
kindIcon(["var", "let", "variable", "local var", "parameter", "value"], Variable, "text-sky-500");
kindIcon(["const", "constant"], Hash, "text-sky-500");
kindIcon(["class", "struct", "local class"], Component, "text-amber-500");
kindIcon(["interface"], Plug, "text-sky-500");
kindIcon(["enum", "enumMember", "enum member"], ListTree, "text-amber-500");
kindIcon(
  ["type", "typeParameter", "type parameter", "alias", "primitive type"],
  Type,
  "text-sky-500",
);
kindIcon(["module", "external module name", "script"], Braces, "text-muted-foreground");
kindIcon(["keyword"], KeyRound, "text-muted-foreground");
kindIcon(["snippet"], SquareDashed, "text-muted-foreground");
kindIcon(["file"], FileText, "text-muted-foreground");
kindIcon(["folder", "directory"], Folder, "text-muted-foreground");

export function CompletionKindIcon(props: { kind: string }) {
  const [Icon, color] = KIND_ICONS[props.kind] ?? [LetterText, "text-muted-foreground"];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", color)} />;
}

/** A completion label with the typed prefix emphasized, as VS Code does. */
export function CompletionLabel(props: { label: string; prefix: string }) {
  const quote = /^["']/.test(props.label) ? 1 : 0;
  const end = props.prefix ? quote + props.prefix.length : 0;
  return (
    <span className="min-w-0 truncate">
      {props.label.slice(0, quote)}
      <span className="font-semibold text-primary">{props.label.slice(quote, end)}</span>
      {props.label.slice(end)}
    </span>
  );
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const directory = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** Definition and reference results grouped by file; selecting one navigates to it. */
export function CodeLocationList(props: {
  items: ReadonlyArray<CodeLocation>;
  emptyText: string;
  onSelect: (item: CodeLocation) => void;
}) {
  const groups = useMemo(() => {
    const byPath = new Map<string, CodeLocation[]>();
    for (const item of props.items) {
      const group = byPath.get(item.path);
      if (group) group.push(item);
      else byPath.set(item.path, [item]);
    }
    return [...byPath];
  }, [props.items]);
  if (props.items.length === 0)
    return <p className="px-3 py-1.5 text-muted-foreground">{props.emptyText}</p>;
  return groups.map(([path, items]) => (
    <div key={path} className="py-0.5">
      <div className="flex items-center gap-1.5 px-2 py-0.5">
        <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{fileName(path)}</span>
        <span className="min-w-0 truncate text-muted-foreground">{directory(path)}</span>
        <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
          {items.length}
        </span>
      </div>
      {items.map((item) => (
        <button
          type="button"
          key={`${item.range.start.line}:${item.range.start.column}`}
          className="flex w-full items-baseline gap-2 py-0.5 pr-2 pl-7 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          onClick={() => props.onSelect(item)}
        >
          <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
            {item.range.start.line}
          </span>
          <span className={cn(CODE_TEXT, "min-w-0 truncate")}>
            {item.preview?.trim() ? (
              <HighlightedCode
                code={item.preview.trim()}
                language={getFiletypeFromFileName(path)}
              />
            ) : (
              `${fileName(path)}:${item.range.start.line}`
            )}
          </span>
        </button>
      ))}
    </div>
  ));
}

export const CODE_POPUP_CLASS = POPUP_CLASS;
export { popupStyle as codePopupStyle };
