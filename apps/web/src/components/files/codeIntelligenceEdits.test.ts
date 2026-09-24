import { describe, expect, it } from "vite-plus/test";
import {
  afterInsertedText,
  completionChoices,
  completionEdit,
  diagnosticsAt,
  editorPosition,
  languagePosition,
  wordAt,
} from "./codeIntelligenceEdits";

describe("Pierre language-service edits", () => {
  it("replaces the whole property at the cursor, preserving punctuation and Unicode", () => {
    const text = "// 🌍\r\nconst café = person.naem;";
    const position = { line: 2, column: 23 };
    const edit = completionEdit(
      { label: "name", insertText: "name", kind: "property", sortText: "0" },
      text,
      position,
    );
    const lines = text.split("\n");
    const line = lines[edit.range.start.line]!;
    expect(
      line.slice(0, edit.range.start.character) +
        edit.newText +
        line.slice(edit.range.end.character),
    ).toBe("const café = person.name;");
    expect(wordAt(text, position).prefix).toBe("na");
  });

  it("honors a language-service replacement range instead of guessing a word", () => {
    const item = {
      label: "city",
      insertText: '["city"]',
      kind: "property",
      sortText: "0",
      range: { start: { line: 1, column: 7 }, end: { line: 1, column: 9 } },
    };
    const text = "person.c;";
    const edit = completionEdit(item, text, { line: 1, column: 9 });
    expect(
      text.slice(0, edit.range.start.character) +
        edit.newText +
        text.slice(edit.range.end.character),
    ).toBe('person["city"];');
  });

  it("places the caret after multiline insertions in UTF-16 coordinates", () => {
    const start = editorPosition({ line: 3, column: 8 });
    expect(languagePosition(afterInsertedText(start, "🌍"))).toEqual({ line: 3, column: 10 });
    expect(languagePosition(afterInsertedText(start, "hello\r\n🌍"))).toEqual({
      line: 4,
      column: 3,
    });
  });

  it("filters completions by the typed prefix and preserves server priority", () => {
    const items = ["name", "city", "CityHall", "citizen"].map((label, index) => ({
      label,
      insertText: label,
      kind: "property",
      sortText: String(4 - index),
    }));
    expect(completionChoices(items, "ci").map((item) => item.label)).toEqual([
      "citizen",
      "CityHall",
      "city",
    ]);
    expect(completionChoices(items, "missing")).toEqual([]);
  });
});

describe("diagnosticsAt", () => {
  const problem = (start: number, end: number, line = 2) => ({
    range: { start: { line, column: start }, end: { line, column: end } },
    message: `${start}-${end}`,
    severity: "error" as const,
    code: 2322,
  });

  it("matches positions inside a range, excluding its end", () => {
    const items = [problem(5, 9), problem(20, 24)];
    expect(diagnosticsAt(items, { line: 2, column: 5 }).map((item) => item.message)).toEqual([
      "5-9",
    ]);
    expect(diagnosticsAt(items, { line: 2, column: 8 }).map((item) => item.message)).toEqual([
      "5-9",
    ]);
    expect(diagnosticsAt(items, { line: 2, column: 9 })).toEqual([]);
    expect(diagnosticsAt(items, { line: 3, column: 6 })).toEqual([]);
  });

  it("matches multi-line ranges and empty ranges at their start", () => {
    const multiLine = {
      ...problem(5, 2),
      range: { start: { line: 2, column: 5 }, end: { line: 4, column: 2 } },
    };
    expect(diagnosticsAt([multiLine], { line: 3, column: 40 })).toHaveLength(1);
    expect(diagnosticsAt([problem(7, 7)], { line: 2, column: 7 })).toHaveLength(1);
    expect(diagnosticsAt([problem(7, 7)], { line: 2, column: 8 })).toEqual([]);
  });
});
