// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { LanguageRequest } from "@t3tools/contracts";
import { WorkspaceLanguageService } from "./WorkspaceLanguageService.ts";
import { plainCompletionText } from "./languageResults.ts";

const positionAt = (text: string, needle: string, last = false) => {
  const offset = last ? text.lastIndexOf(needle) : text.indexOf(needle);
  const before = text.slice(0, offset);
  return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n") };
};

describe("additional workspace languages", () => {
  let cwd: string;
  let service: WorkspaceLanguageService;
  beforeEach(async () => {
    cwd = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-languages-")),
    );
    service = new WorkspaceLanguageService();
  });
  afterEach(async () => {
    service.dispose();
    await NodeFSP.rm(cwd, { recursive: true, force: true });
  });

  const request = (
    relativePath: string,
    contents: string,
    operation: LanguageRequest["operation"],
    position?: LanguageRequest["position"],
    version = 1,
  ) =>
    service.request({
      sessionId: relativePath,
      cwd,
      relativePath,
      operation,
      version,
      update: { _tag: "open", contents },
      ...(position ? { position } : {}),
    });

  it("uses local JSON schemas for completion, documentation, validation, and formatting", async () => {
    await NodeFSP.writeFile(
      NodePath.join(cwd, "schema.json"),
      JSON.stringify({
        type: "object",
        properties: {
          name: { type: "string", description: "The person's display name." },
          age: { type: "integer", minimum: 0 },
        },
      }),
    );
    const contents = '{"$schema":"./schema.json","name":4}';
    await NodeFSP.writeFile(NodePath.join(cwd, "demo.json"), contents);
    const diagnostics = await request("demo.json", contents, "diagnostics");
    expect(diagnostics._tag).toBe("diagnostics");
    if (diagnostics._tag === "diagnostics")
      expect(
        diagnostics.items.some((item) => item.source === "json" || item.source === "JSON"),
      ).toBe(true);
    const hover = await request("demo.json", contents, "hover", positionAt(contents, "name"));
    expect(hover._tag === "hover" && hover.info?.documentation).toMatch(/display(?:&nbsp;| )name/);
    const completionText = '{"$schema":"./schema.json", ""}';
    const completions = await request(
      "demo.json",
      completionText,
      "completions",
      { line: 1, column: completionText.length - 1 },
      2,
    );
    expect(
      completions._tag === "completions" &&
        completions.items.some((item) => item.label.includes("age")),
    ).toBe(true);
    const formatted = await request("demo.json", contents, "format", undefined, 3);
    expect(formatted._tag === "format" && formatted.edits.length > 0).toBe(true);
    expect(await NodeFSP.readFile(NodePath.join(cwd, "demo.json"), "utf8")).toBe(contents);
  });

  it("allows comments in JSONC and resolves local JSON pointers", async () => {
    const contents =
      '{\n  "$defs": {"Person": {"type": "string"}},\n  "properties": {"person": {"$ref": "#/$defs/Person"}}\n}';
    await NodeFSP.writeFile(NodePath.join(cwd, "schema.json"), contents);
    const definition = await request(
      "schema.json",
      contents,
      "definition",
      positionAt(contents, "#/$defs/Person"),
    );
    expect(definition._tag === "locations" && definition.items[0]?.range.start.line).toBe(2);
    const references = await request(
      "schema.json",
      contents,
      "references",
      positionAt(contents, "Person"),
    );
    expect(references._tag === "locations" && references.items[0]?.range.start.line).toBe(3);
    const jsonc = '{\n// configuration\n"enabled": true,\n}';
    await NodeFSP.writeFile(NodePath.join(cwd, "demo.jsonc"), jsonc);
    const diagnostics = await request("demo.jsonc", jsonc, "diagnostics");
    expect(diagnostics).toEqual({ _tag: "diagnostics", items: [] });
  });

  it("reports missing native tools and allows a fresh session after failure", async () => {
    const previous = process.env.T3CODE_BUF_PATH;
    process.env.T3CODE_BUF_PATH = NodePath.join(cwd, "missing-buf");
    await NodeFSP.writeFile(NodePath.join(cwd, "demo.proto"), 'syntax = "proto3";');
    try {
      await expect(request("demo.proto", 'syntax = "proto3";', "diagnostics")).rejects.toThrow(
        /require Buf/,
      );
      await expect(request("demo.proto", 'syntax = "proto3";', "diagnostics")).rejects.toThrow(
        /require Buf/,
      );
    } finally {
      if (previous === undefined) delete process.env.T3CODE_BUF_PATH;
      else process.env.T3CODE_BUF_PATH = previous;
    }
  });

  it.runIf(!!process.env.T3CODE_RUST_ANALYZER_PATH)(
    "analyzes Rust through a real rust-analyzer process",
    async () => {
      await NodeFSP.writeFile(
        NodePath.join(cwd, "Cargo.toml"),
        '[package]\nname = "t3_language_demo"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "lib.rs"\n',
      );
      const contents =
        "pub struct Person { pub age: u32 }\npub fn age(person: Person) -> u32 { person.age }\n";
      await NodeFSP.writeFile(NodePath.join(cwd, "lib.rs"), contents);
      const definition = await request(
        "lib.rs",
        contents,
        "definition",
        positionAt(contents, "age", true),
      );
      expect(definition._tag === "locations" && definition.items[0]?.range.start.line).toBe(1);
      const hover = await request("lib.rs", contents, "hover", positionAt(contents, "age", true));
      expect(hover._tag === "hover" && hover.info?.documentation).toContain("u32");
      const completions = await request(
        "lib.rs",
        contents,
        "completions",
        positionAt(contents, "age", true),
      );
      expect(
        completions._tag === "completions" &&
          completions.items.some((item) => item.label.includes("age")),
      ).toBe(true);
      const references = await request(
        "lib.rs",
        contents,
        "references",
        positionAt(contents, "age", true),
      );
      expect(references._tag === "locations" && references.items.length >= 2).toBe(true);
      const formatted = await request("lib.rs", contents, "format");
      expect(formatted._tag === "format" && formatted.edits.length > 0).toBe(true);
      const broken = contents.replace("-> u32", "-> bool");
      const diagnostics = await request("lib.rs", broken, "diagnostics", undefined, 2);
      expect(
        diagnostics._tag === "diagnostics" &&
          diagnostics.items.some((item) => /mismatch|expected.*bool/i.test(item.message)),
      ).toBe(true);
      expect(await NodeFSP.readFile(NodePath.join(cwd, "lib.rs"), "utf8")).toBe(contents);
    },
    60_000,
  );

  it.runIf(!!process.env.T3CODE_BUF_PATH)(
    "reloads Protobuf imports after workspace changes",
    async () => {
      await NodeFSP.writeFile(
        NodePath.join(cwd, "buf.yaml"),
        "version: v2\nmodules:\n  - path: .\n",
      );
      const imported = NodePath.join(cwd, "types.proto");
      await NodeFSP.writeFile(imported, 'syntax = "proto3"; package demo; message Person {}');
      const contents =
        'syntax = "proto3"; package demo; import "types.proto"; message Greeting { Person person = 1; }';
      await NodeFSP.writeFile(NodePath.join(cwd, "demo.proto"), contents);
      const initial = await request("demo.proto", contents, "diagnostics");
      expect(
        initial._tag === "diagnostics" &&
          initial.items.some((item) => /unknown type/i.test(item.message)),
      ).toBe(false);
      await NodeFSP.writeFile(imported, 'syntax = "proto3"; package demo; message Other {}');
      const refreshed = await request("demo.proto", contents, "refresh");
      expect(
        refreshed._tag === "diagnostics" &&
          refreshed.items.some((item) => /Person/.test(item.message)),
      ).toBe(true);
    },
    60_000,
  );

  // Pyright ships with the server, so this runs everywhere unless a path overrides it.
  it("analyzes Python through the built-in Pyright", async () => {
    await NodeFSP.writeFile(
      NodePath.join(cwd, "shapes.py"),
      'class Circle:\n    """A circle with a radius."""\n\n    def __init__(self, radius: float) -> None:\n        self.radius = radius\n\n    def area(self) -> float:\n        return 3.14 * self.radius ** 2\n',
    );
    const contents = "from shapes import Circle\n\ncircle = Circle(2.0)\nprint(circle.area())\n";
    await NodeFSP.writeFile(NodePath.join(cwd, "main.py"), contents);
    const hover = await request("main.py", contents, "hover", positionAt(contents, "Circle", true));
    expect(hover._tag === "hover" && hover.info?.documentation).toContain("A circle with a radius");
    const definition = await request(
      "main.py",
      contents,
      "definition",
      positionAt(contents, "area"),
    );
    expect(definition).toMatchObject({
      _tag: "locations",
      items: [
        expect.objectContaining({
          path: "shapes.py",
          range: expect.objectContaining({ start: { line: 7, column: 9 } }),
        }),
      ],
    });
    const completions = await request("main.py", contents, "completions", {
      ...positionAt(contents, "area"),
    });
    expect(
      completions._tag === "completions" &&
        completions.items.some((item) => item.label === "radius"),
    ).toBe(true);
    const signature = await request("main.py", contents, "signature", {
      ...positionAt(contents, "2.0"),
    });
    expect(signature).toMatchObject({
      _tag: "signature",
      items: [expect.objectContaining({ label: expect.stringContaining("radius: float") })],
    });
    const references = await request(
      "main.py",
      contents,
      "references",
      positionAt(contents, "Circle", true),
    );
    expect(references._tag === "locations" && references.items.length >= 3).toBe(true);
    const broken = contents.replace("Circle(2.0)", 'Circle("wide")');
    const diagnostics = await request("main.py", broken, "diagnostics", undefined, 2);
    expect(diagnostics).toMatchObject({
      _tag: "diagnostics",
      items: [expect.objectContaining({ severity: "error", source: expect.anything() })],
    });
    expect(await NodeFSP.readFile(NodePath.join(cwd, "main.py"), "utf8")).toBe(contents);
  }, 60_000);

  it.runIf(!!process.env.T3CODE_BUF_PATH)(
    "moves one Buf session between files",
    async () => {
      await NodeFSP.writeFile(
        NodePath.join(cwd, "buf.yaml"),
        "version: v2\nmodules:\n  - path: .\n",
      );
      const types = 'syntax = "proto3";\npackage demo;\nmessage Person {}\n';
      const demo =
        'syntax = "proto3";\npackage demo;\nimport "types.proto";\nmessage Greeting { Person person = 1; }\n';
      await NodeFSP.writeFile(NodePath.join(cwd, "types.proto"), types);
      await NodeFSP.writeFile(NodePath.join(cwd, "demo.proto"), demo);
      const ask = (relativePath: string, contents: string, version: number) =>
        service.request({
          sessionId: "diff",
          cwd,
          relativePath,
          operation: "definition",
          version,
          update: { _tag: "open", contents },
          position: positionAt(contents, "Person", true),
        });
      expect(await ask("demo.proto", demo, 1)).toMatchObject({
        items: [expect.objectContaining({ path: "types.proto" })],
      });
      expect(await ask("types.proto", types, 2)).toMatchObject({
        items: [expect.objectContaining({ path: "types.proto" })],
      });
    },
    60_000,
  );

  it.runIf(!!process.env.T3CODE_BUF_PATH)(
    "analyzes Protobuf through a real Buf language server",
    async () => {
      await NodeFSP.writeFile(
        NodePath.join(cwd, "buf.yaml"),
        "version: v2\nmodules:\n  - path: .\nlint:\n  use:\n    - MINIMAL\n",
      );
      const contents =
        'syntax = "proto3";\npackage demo;\n// Person receives a greeting.\nmessage Person { string name = 1; }\nmessage Greeting { Person person = 1; }\n';
      await NodeFSP.writeFile(NodePath.join(cwd, "demo.proto"), contents);
      const definition = await request(
        "demo.proto",
        contents,
        "definition",
        positionAt(contents, "Person", true),
      );
      expect(definition._tag === "locations" && definition.items[0]?.range.start.line).toBe(4);
      const point = positionAt(contents, "Person", true);
      const hover = await request("demo.proto", contents, "hover", {
        ...point,
        column: point.column + 2,
      });
      expect(hover._tag === "hover" && hover.info?.documentation).toContain("Person");
      const references = await request("demo.proto", contents, "references", point);
      expect(references._tag === "locations" && references.items.length >= 1).toBe(true);
      const completions = await request("demo.proto", contents, "completions", point);
      expect(
        completions._tag === "completions" &&
          completions.items.some((item) => item.label.includes("Person")),
      ).toBe(true);
      const formatted = await request("demo.proto", contents, "format");
      expect(formatted._tag === "format" && formatted.edits.length > 0).toBe(true);
      const broken = contents.replace("Person person", "Unknown person");
      const diagnostics = await request("demo.proto", broken, "diagnostics", undefined, 2);
      expect(
        diagnostics._tag === "diagnostics" &&
          diagnostics.items.some((item) => /Unknown/.test(item.message)),
      ).toBe(true);
      expect(await NodeFSP.readFile(NodePath.join(cwd, "demo.proto"), "utf8")).toBe(contents);
    },
    60_000,
  );
});

describe("plain completion inserts", () => {
  it.each([
    ['"name": "$1"$0', '"name": ""'],
    ["${1:hello} ${2:world}", "hello world"],
    ["${1|true,false|}", "true"],
    ['${1:{ "name": "${2:hello}" }}$0', '{ "name": "hello" }'],
    ["\\$schema", "$schema"],
  ])("preserves defaults and strips tab stops from %s", (snippet, expected) => {
    expect(plainCompletionText(snippet)).toBe(expected);
  });
});
