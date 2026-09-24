import type { CodeDiagnostic, LanguageRequest, LanguageResult } from "@t3tools/contracts";
import type { Position, Range, TextEdit } from "@pierre/diffs/editor";

export type CodePosition = NonNullable<LanguageRequest["position"]>;
export type Completion = Extract<LanguageResult, { _tag: "completions" }>["items"][number];

export const languagePosition = (position: Position): CodePosition => ({
  line: position.line + 1,
  column: position.character + 1,
});
export const editorPosition = (position: CodePosition): Position => ({
  line: position.line - 1,
  character: position.column - 1,
});
export const editorRange = (range: { start: CodePosition; end: CodePosition }): Range => ({
  start: editorPosition(range.start),
  end: editorPosition(range.end),
});

export function wordAt(text: string, position: CodePosition) {
  const line = text.split("\n")[position.line - 1] ?? "";
  return wordAtLine(line, position);
}

export function wordAtLine(line: string, position: CodePosition) {
  const offset = position.column - 1;
  const before = line.slice(0, offset).match(/[\p{ID_Continue}$]+$/u)?.[0] ?? "";
  const after = line.slice(offset).match(/^[\p{ID_Continue}$]+/u)?.[0] ?? "";
  return {
    prefix: before,
    text: before + after,
    range: {
      start: { line: position.line, column: position.column - before.length },
      end: { line: position.line, column: position.column + after.length },
    },
  };
}

export function completionChoices(items: ReadonlyArray<Completion>, prefix: string) {
  const lower = prefix.toLowerCase();
  return items
    .filter((item) => item.label.replace(/^["']/, "").toLowerCase().startsWith(lower))
    .toSorted((a, b) => a.sortText.localeCompare(b.sortText) || a.label.localeCompare(b.label))
    .slice(0, 100);
}

export function completionEdit(item: Completion, text: string, position: CodePosition): TextEdit {
  return {
    range: editorRange(item.range ?? wordAt(text, position).range),
    newText: item.insertText,
  };
}

export function afterInsertedText(start: Position, text: string): Position {
  const lines = text.split("\n");
  return lines.length === 1
    ? { line: start.line, character: start.character + text.length }
    : { line: start.line + lines.length - 1, character: lines.at(-1)!.length };
}

const before = (a: CodePosition, b: CodePosition) =>
  a.line < b.line || (a.line === b.line && a.column < b.column);

/** Problems whose range covers a position; an empty range still matches its own start. */
export function diagnosticsAt(items: ReadonlyArray<CodeDiagnostic>, position: CodePosition) {
  return items.filter(
    ({ range }) =>
      !before(position, range.start) &&
      (before(position, range.end) ||
        (range.start.line === range.end.line && range.start.column === range.end.column
          ? position.line === range.start.line && position.column === range.start.column
          : false)),
  );
}
