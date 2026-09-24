// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { LanguageResult, type LanguageRequest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { WorkspaceLanguageService } from "./WorkspaceLanguageService.ts";

const decodeResult = Schema.decodeUnknownSync(LanguageResult);

describe("workspace TypeScript language service", () => {
  let cwd: string;
  let service: WorkspaceLanguageService;
  const contents =
    'import { greet } from "./greet";\nconst result = greet("Ada");\nresult.toUpperCase();\n';
  const query = async (
    operation: LanguageRequest["operation"],
    extra: Partial<LanguageRequest> = {},
  ) => {
    const result = await service.request({
      cwd,
      relativePath: "main.ts",
      sessionId: "editor",
      version: 1,
      operation,
      ...extra,
    });
    return decodeResult(result);
  };
  const open = (extra: Partial<LanguageRequest> = {}) =>
    query("diagnostics", { update: { _tag: "open", contents }, ...extra });

  beforeEach(async () => {
    cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-language-"));
    service = new WorkspaceLanguageService();
    await NodeFSP.writeFile(
      NodePath.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
        },
        include: ["*.ts"],
      }),
    );
    await NodeFSP.writeFile(NodePath.join(cwd, "main.ts"), contents);
    await NodeFSP.writeFile(
      NodePath.join(cwd, "greet.ts"),
      "/** Greet a person by name. */\nexport function greet(name: string): string { return `Hello, ${name}`; }\n",
    );
  });
  afterEach(async () => {
    service.dispose();
    await NodeFSP.rm(cwd, { recursive: true, force: true });
  });

  it("resolves completion, hover, definitions, references, and signatures across project files", async () => {
    expect(await open()).toMatchObject({ _tag: "diagnostics", items: [] });
    const completions = await query("completions", { position: { line: 3, column: 8 } });
    expect(completions).toMatchObject({
      _tag: "completions",
      items: expect.arrayContaining([expect.objectContaining({ label: "toUpperCase" })]),
    });
    const hover = await query("hover", { position: { line: 2, column: 17 } });
    expect(hover).toMatchObject({
      _tag: "hover",
      info: { display: expect.stringContaining("greet"), documentation: "Greet a person by name." },
    });
    expect(await query("definition", { position: { line: 2, column: 17 } })).toMatchObject({
      _tag: "locations",
      items: [
        expect.objectContaining({
          path: "greet.ts",
          range: { start: { line: 2, column: 17 }, end: { line: 2, column: 22 } },
        }),
      ],
    });
    const references = await query("references", { position: { line: 2, column: 17 } });
    expect(references).toMatchObject({
      _tag: "locations",
      items: expect.arrayContaining([
        expect.objectContaining({ path: "main.ts" }),
        expect.objectContaining({ path: "greet.ts" }),
      ]),
    });
    expect(await query("signature", { position: { line: 2, column: 23 } })).toMatchObject({
      _tag: "signature",
      items: [expect.objectContaining({ label: expect.stringContaining("name: string") })],
    });
  });

  it("analyzes incremental unsaved edits, keeps sessions isolated, and leaves disk untouched", async () => {
    await open();
    const start = contents.indexOf('"Ada"');
    const bad = await query("diagnostics", {
      version: 2,
      update: { _tag: "change", baseVersion: 1, start, deleteLength: 5, text: "123" },
    });
    expect(bad).toMatchObject({
      _tag: "diagnostics",
      items: expect.arrayContaining([expect.objectContaining({ code: 2345, severity: "error" })]),
    });
    expect(await open({ sessionId: "second-editor" })).toMatchObject({
      _tag: "diagnostics",
      items: [],
    });
    expect(await NodeFSP.readFile(NodePath.join(cwd, "main.ts"), "utf8")).toBe(contents);
    const fixed = await query("diagnostics", {
      version: 3,
      update: { _tag: "change", baseVersion: 2, start, deleteLength: 3, text: '"Grace"' },
    });
    expect(fixed).toMatchObject({ _tag: "diagnostics", items: [] });
  });

  it("refreshes diagnostics after an agent changes an imported file", async () => {
    await open();
    await NodeFSP.writeFile(
      NodePath.join(cwd, "greet.ts"),
      "export function greet(name: number): string { return String(name); }\n",
    );
    expect(await query("refresh")).toMatchObject({
      _tag: "diagnostics",
      items: expect.arrayContaining([expect.objectContaining({ code: 2345 })]),
    });
  });

  it("completes JavaScript properties using JSDoc types", async () => {
    const contents =
      '/** @type {{name: string, city: string}} */\nconst person = { name: "Ada", city: "Berlin" };\nperson.\n';
    await NodeFSP.writeFile(NodePath.join(cwd, "main.js"), contents);
    const result = await query("completions", {
      relativePath: "main.js",
      update: { _tag: "open", contents },
      position: { line: 3, column: 8 },
    });
    expect(result).toMatchObject({
      _tag: "completions",
      items: expect.arrayContaining([
        expect.objectContaining({ label: "city" }),
        expect.objectContaining({ label: "name" }),
      ]),
    });
  });

  it("moves one session between files, keeping unsaved buffers per file", async () => {
    await open();
    const greet =
      "export function greet(name: string): string { return name; }\nexport const unsaved = 1;\n";
    await expect(
      query("hover", { relativePath: "greet.ts", position: { line: 1, column: 17 } }),
    ).rejects.toMatchObject({ resync: true });
    expect(
      await query("hover", {
        relativePath: "greet.ts",
        version: 2,
        update: { _tag: "open", contents: greet },
        position: { line: 2, column: 14 },
      }),
    ).toMatchObject({ _tag: "hover", info: { display: expect.stringContaining("unsaved") } });
    expect(
      await query("definition", {
        relativePath: "main.ts",
        version: 3,
        update: { _tag: "open", contents },
        position: { line: 2, column: 17 },
      }),
    ).toMatchObject({ _tag: "locations", items: [expect.objectContaining({ path: "greet.ts" })] });
    await NodeFSP.writeFile(NodePath.join(cwd, "data.json"), '{"a": 1}');
    expect(
      await query("diagnostics", {
        relativePath: "data.json",
        version: 4,
        update: { _tag: "open", contents: '{"a": }' },
      }),
    ).toMatchObject({ _tag: "diagnostics", items: [expect.anything()] });
  });

  it("rejects stale patches and recovers after a session closes", async () => {
    await open();
    await expect(
      query("hover", {
        version: 2,
        update: { _tag: "change", baseVersion: 0, start: 0, deleteLength: 0, text: "// stale\n" },
      }),
    ).rejects.toMatchObject({ resync: true });
    await query("close");
    await expect(query("diagnostics")).rejects.toMatchObject({ resync: true });
    expect(await open()).toMatchObject({ _tag: "diagnostics", items: [] });
  });

  it("returns formatting edits and syntax errors for an unsaved document", async () => {
    await open({ update: { _tag: "open", contents: "const value={name:'Ada'};\n" } });
    const formatted = await query("format");
    expect(formatted._tag).toBe("format");
    if (formatted._tag === "format") expect(formatted.edits.length).toBeGreaterThan(0);
    expect(
      await query("diagnostics", {
        version: 2,
        update: { _tag: "open", contents: "const value = ;" },
      }),
    ).toMatchObject({
      _tag: "diagnostics",
      items: expect.arrayContaining([expect.objectContaining({ code: 1109 })]),
    });
  });

  it("rejects paths outside the workspace and requests after disposal", async () => {
    await expect(open({ relativePath: "../outside.ts" })).rejects.toThrow();
    service.dispose();
    await expect(open()).rejects.toMatchObject({ message: "Connection closed." });
  });
});
