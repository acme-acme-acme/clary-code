// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { CodeDiagnostic, CodeLocation, LanguageResult } from "@t3tools/contracts";
import type { Position, Range, TextEdit } from "vscode-json-languageservice";

interface CompletionInput {
  label: string;
  kind?: number | undefined;
  sortText?: string | undefined;
  insertText?: string | undefined;
  insertTextFormat?: number | undefined;
  textEdit?: TextEdit | { insert: Range; replace: Range; newText: string } | undefined;
  additionalTextEdits?: ReadonlyArray<TextEdit> | undefined;
}
interface DiagnosticInput {
  range: Range;
  message: string;
  severity?: number | undefined;
  code?: number | string | undefined;
  source?: string | undefined;
}

export const codePosition = (position: Position) => ({
  line: position.line + 1,
  column: position.character + 1,
});
export const codeRange = (range: Range) => ({
  start: codePosition(range.start),
  end: codePosition(range.end),
});
export function codeLocation(root: string, uri: string, range: Range): CodeLocation | undefined {
  if (!uri.startsWith("file:")) return;
  const file = NodeURL.fileURLToPath(uri);
  const relative = NodePath.relative(root, file);
  return {
    path:
      relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative)
        ? file
        : relative.replaceAll(NodePath.sep, "/"),
    range: codeRange(range),
  };
}

/** Preserve snippet defaults as plain text until the editor supports tab stops. */
export function plainCompletionText(text: string): string {
  let output = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && /[$}\\]/.test(text[i + 1] ?? "")) {
      output += text[++i];
      continue;
    }
    if (text[i] !== "$") {
      output += text[i];
      continue;
    }
    const simple = text.slice(i).match(/^\$\d+/);
    if (simple) {
      i += simple[0].length - 1;
      continue;
    }
    const placeholder = text.slice(i).match(/^\$\{\d+([:|}])/);
    if (!placeholder) {
      output += "$";
      continue;
    }
    const start = i + placeholder[0].length;
    if (placeholder[1] === "}") {
      i = start - 1;
      continue;
    }
    let end = start,
      depth = 1;
    for (; end < text.length; end++) {
      if (text[end] === "\\") {
        end++;
        continue;
      }
      if (text[end] === "{") depth++;
      if (text[end] === "}" && --depth === 0) break;
    }
    const value = text.slice(start, end);
    output +=
      placeholder[1] === "|" ? value.replace(/\|$/, "").split(",")[0] : plainCompletionText(value);
    i = end;
  }
  return output;
}

const kinds = [
  "text",
  "method",
  "function",
  "constructor",
  "field",
  "variable",
  "class",
  "interface",
  "module",
  "property",
  "unit",
  "value",
  "enum",
  "keyword",
  "snippet",
  "color",
  "file",
  "reference",
  "folder",
  "enum",
  "const",
  "struct",
  "event",
  "operator",
  "type",
];
export function completionResult(items: ReadonlyArray<CompletionInput>): LanguageResult {
  return {
    _tag: "completions",
    items: items
      .filter((item) => !item.additionalTextEdits?.length)
      .slice(0, 1000)
      .map((item) => {
        const edit = item.textEdit;
        const text = edit?.newText ?? item.insertText ?? item.label;
        const range = edit && ("range" in edit ? edit.range : edit.replace);
        return {
          label: item.label,
          kind: kinds[(item.kind ?? 1) - 1] ?? "text",
          sortText: item.sortText ?? item.label,
          insertText: item.insertTextFormat === 2 ? plainCompletionText(text) : text,
          ...(range ? { range: codeRange(range) } : {}),
        };
      }),
  };
}
export function diagnosticResults(
  items: ReadonlyArray<DiagnosticInput>,
  source: string,
): CodeDiagnostic[] {
  return items.slice(0, 500).map((item) => ({
    range: codeRange(item.range),
    message: item.message,
    severity: item.severity === 1 ? "error" : item.severity === 2 ? "warning" : "message",
    code: item.code ?? "",
    source: item.source ?? source,
  }));
}
export function formattingResult(edits: ReadonlyArray<TextEdit>): LanguageResult {
  return {
    _tag: "format",
    edits: edits.map((edit) => ({ range: codeRange(edit.range), text: edit.newText })),
  };
}
