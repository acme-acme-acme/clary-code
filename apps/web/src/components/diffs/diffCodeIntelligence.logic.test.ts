import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  diagnosticLineSpans,
  diffLineMatches,
  diffNewSideText,
} from "./diffCodeIntelligence.logic";

const fileDiff = (overrides: Partial<FileDiffMetadata>) =>
  ({
    name: "src/a.ts",
    type: "change",
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: false,
    deletionLines: [],
    additionLines: [],
    ...overrides,
  }) as FileDiffMetadata;

const problem = (start: [number, number], end: [number, number]) => ({
  range: {
    start: { line: start[0], column: start[1] },
    end: { line: end[0], column: end[1] },
  },
  message: "bad",
  severity: "error" as const,
  code: 1,
});

describe("diffNewSideText", () => {
  it("rebuilds the full new file from hydrated lines", () => {
    expect(diffNewSideText(fileDiff({ additionLines: ["a\n", "b\n", "c"] }))).toBe("a\nb\nc");
    expect(diffNewSideText(fileDiff({ additionLines: ["a", "b"] }))).toBe("a\nb");
  });

  it("has no full text for patch-only or deleted files", () => {
    expect(diffNewSideText(fileDiff({ isPartial: true, additionLines: ["a\n"] }))).toBeNull();
    expect(diffNewSideText(fileDiff({ type: "deleted" }))).toBeNull();
  });
});

describe("diffLineMatches", () => {
  const contents = "const a = 1;\r\nconst b = 2;  \n";
  it("compares a rendered line with the analyzed text, ignoring line endings", () => {
    expect(diffLineMatches(contents, 1, "const a = 1;\n")).toBe(true);
    expect(diffLineMatches(contents, 2, "const b = 2;")).toBe(true);
  });

  it("rejects a line from another revision or past the end", () => {
    expect(diffLineMatches(contents, 1, "const a = 3;")).toBe(false);
    expect(diffLineMatches(contents, 9, "")).toBe(false);
  });
});

describe("diagnosticLineSpans", () => {
  const lengths = new Map([
    [3, 20],
    [4, 10],
    [6, 8],
  ]);
  const length = (line: number) => lengths.get(line);

  it("splits multi-line problems and skips lines the diff does not show", () => {
    expect(diagnosticLineSpans(problem([3, 5], [6, 4]), length)).toEqual([
      { line: 3, start: 5, end: 21 },
      { line: 4, start: 1, end: 11 },
      { line: 6, start: 1, end: 4 },
    ]);
  });

  it("widens an empty range to one character and clips to the line", () => {
    expect(diagnosticLineSpans(problem([4, 3], [4, 3]), length)).toEqual([
      { line: 4, start: 3, end: 4 },
    ]);
    expect(diagnosticLineSpans(problem([4, 8], [4, 40]), length)).toEqual([
      { line: 4, start: 8, end: 11 },
    ]);
  });
});
