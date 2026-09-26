import { describe, expect, it } from "vite-plus/test";
import {
  LanguageServiceError,
  type LanguageRequest,
  type LanguageResult,
} from "@t3tools/contracts";
import { codeTextChange, CodeLanguageSession } from "./codeLanguageSession";

describe("code language synchronization", () => {
  it.each([
    ["hello", "hello world"],
    ["hello world", "hello"],
    ["", "hello"],
    ["hello", ""],
    ["same", "same"],
    ["// 🌍\r\nconst x = 1;", "// 🌍\r\nconst x = 'two';"],
  ])("reconstructs edited UTF-16 text from a compact replacement", (before, after) => {
    const change = codeTextChange(before, after);
    expect(
      before.slice(0, change.start) +
        change.text +
        before.slice(change.start + change.deleteLength),
    ).toBe(after);
  });

  it("resends a complete buffer after reconnect and skips canceled queued queries", async () => {
    const sent: LanguageRequest[] = [];
    let expired = false;
    const session = new CodeLanguageSession(
      { cwd: "/project", relativePath: "main.ts" },
      async (input): Promise<LanguageResult> => {
        sent.push(input);
        if (expired && input.update?._tag !== "open") {
          expired = false;
          throw new LanguageServiceError({ message: "Expired", resync: true });
        }
        return { _tag: "diagnostics", items: [] };
      },
    );
    await session.request({ contents: "const x = 1;", version: 1 }, "diagnostics");
    expired = true;
    await session.request({ contents: "const x = 2;", version: 2 }, "diagnostics");
    expect(sent.map((request) => request.update?._tag)).toEqual(["open", "change", "open"]);
    expect(sent[1]?.update).toMatchObject({ start: 10, deleteLength: 1, text: "2" });
    await session.request({ contents: "const x = 3;", version: 3 }, "hover", undefined, () => true);
    expect(sent).toHaveLength(3);
    session.dispose();
  });

  it("reopens the buffer when a request names another file", async () => {
    const sent: LanguageRequest[] = [];
    const session = new CodeLanguageSession(
      { cwd: "/project", relativePath: "a.ts" },
      async (input): Promise<LanguageResult> => {
        sent.push(input);
        return { _tag: "hover", info: null };
      },
    );
    const b = { cwd: "/project", relativePath: "b.ts" };
    await session.request({ contents: "a", version: 1 }, "hover");
    await session.request({ contents: "b", version: 2, target: b }, "hover");
    await session.request({ contents: "bb", version: 3, target: b }, "hover");
    await session.request({ contents: "a", version: 4 }, "hover");
    expect(sent.map((request) => [request.relativePath, request.update?._tag])).toEqual([
      ["a.ts", "open"],
      ["b.ts", "open"],
      ["b.ts", "change"],
      ["a.ts", "open"],
    ]);
    expect(new Set(sent.map((request) => request.sessionId)).size).toBe(1);
    session.dispose();
  });
});
