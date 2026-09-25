import type { FileDiffMetadata } from "@pierre/diffs";
import type { CodeDiagnostic } from "@t3tools/contracts";

/** The complete new side of a diff when Pierre already holds it; null for patch-only diffs. */
export function diffNewSideText(fileDiff: FileDiffMetadata): string | null {
  if (fileDiff.isPartial || fileDiff.type === "deleted") return null;
  const lines = fileDiff.additionLines;
  // Pierre keeps line endings on each line; tolerate producers that strip them.
  const kept = lines.slice(0, -1).every((line) => line.endsWith("\n"));
  return kept ? lines.join("") : lines.join("\n");
}

/**
 * Whether a rendered new-side line still says what the analyzed text says. Analysis runs
 * on text that can differ from the rendered revision (a disk read for an old turn), and
 * a mismatched line must not show another revision's types.
 */
export function diffLineMatches(contents: string, line: number, rendered: string): boolean {
  const lines = contents.split("\n");
  const source = lines[line - 1];
  if (source === undefined) return false;
  return source.replace(/\r$/, "").trimEnd() === rendered.replace(/\n$/, "").trimEnd();
}

/** Per-line column spans to underline for each problem, clipped to the line lengths given. */
export function diagnosticLineSpans(
  item: CodeDiagnostic,
  lineLength: (line: number) => number | undefined,
): Array<{ line: number; start: number; end: number }> {
  const spans: Array<{ line: number; start: number; end: number }> = [];
  for (let line = item.range.start.line; line <= item.range.end.line; line++) {
    const length = lineLength(line);
    if (length === undefined) continue;
    const start = line === item.range.start.line ? item.range.start.column : 1;
    let end = line === item.range.end.line ? item.range.end.column : length + 1;
    end = Math.min(end, length + 1);
    // An empty range marks a point; underline one character so it stays visible.
    if (end <= start) end = Math.min(start + 1, length + 1);
    if (end > start) spans.push({ line, start, end });
  }
  return spans;
}
