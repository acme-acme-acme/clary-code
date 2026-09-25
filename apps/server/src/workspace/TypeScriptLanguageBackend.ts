// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import type { LanguageRequest, LanguageResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { TypeScriptSession } from "./TypeScriptSession.ts";
import type { LanguageBackend, DocumentChange } from "./LanguageBackend.ts";
const Position = Schema.Struct({ line: Schema.Number, offset: Schema.Number });
const Span = { start: Position, end: Position };
const DisplayParts = Schema.Array(Schema.Struct({ text: Schema.String }));
const Documentation = Schema.Union([Schema.String, DisplayParts]);
const CompletionInfo = Schema.Struct({
  optionalReplacementSpan: Schema.optional(Schema.Struct(Span)),
  entries: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      kind: Schema.String,
      sortText: Schema.String,
      insertText: Schema.optional(Schema.String),
      replacementSpan: Schema.optional(Schema.Struct(Span)),
    }),
  ),
});
const Hover = Schema.Struct({
  ...Span,
  displayString: Schema.String,
  documentation: Documentation,
});
const FileSpan = Schema.Struct({
  ...Span,
  file: Schema.String,
  lineText: Schema.optional(Schema.String),
});
const Diagnostic = Schema.Struct({
  ...Span,
  text: Schema.String,
  code: Schema.Number,
  category: Schema.Literals(["error", "warning", "suggestion", "message"]),
});
const Signatures = Schema.Struct({
  selectedItemIndex: Schema.Number,
  argumentIndex: Schema.Number,
  items: Schema.Array(
    Schema.Struct({
      prefixDisplayParts: DisplayParts,
      suffixDisplayParts: DisplayParts,
      separatorDisplayParts: DisplayParts,
      documentation: DisplayParts,
      parameters: Schema.Array(
        Schema.Struct({ displayParts: DisplayParts, documentation: DisplayParts }),
      ),
    }),
  ),
});
const TextEdits = Schema.Array(Schema.Struct({ ...Span, newText: Schema.String }));
const decodeCompletions = Schema.decodeUnknownSync(CompletionInfo);
const decodeHover = Schema.decodeUnknownSync(Hover);
const decodeLocations = Schema.decodeUnknownSync(Schema.Array(FileSpan));
const decodeReferences = Schema.decodeUnknownSync(Schema.Struct({ refs: Schema.Array(FileSpan) }));
const decodeDiagnostics = Schema.decodeUnknownSync(Schema.Array(Diagnostic));
const decodeSignatures = Schema.decodeUnknownSync(Signatures);
const decodeTextEdits = Schema.decodeUnknownSync(TextEdits);

const range = (span: { start: typeof Position.Type; end: typeof Position.Type }) => ({
  start: { line: span.start.line, column: span.start.offset },
  end: { line: span.end.line, column: span.end.offset },
});
const display = (parts: typeof Documentation.Type) =>
  typeof parts === "string" ? parts : parts.map((part) => part.text).join("");

function positionAt(text: string, offset: number) {
  const prefix = text.slice(0, offset);
  return { line: prefix.split("\n").length, offset: offset - prefix.lastIndexOf("\n") };
}

export class TypeScriptLanguageBackend implements LanguageBackend {
  private readonly server: TypeScriptSession;
  private contents = "";
  private opened = false;
  private readonly root: string;
  private file: string;
  constructor(root: string, file: string) {
    this.root = root;
    this.file = file;
    this.server = new TypeScriptSession(root);
  }
  get closed() {
    return this.server.closed;
  }
  dispose() {
    this.server.dispose();
  }
  async retarget(file: string) {
    if (this.opened) await this.server.request("close", { file: this.file });
    this.file = file;
    this.opened = false;
    this.contents = "";
  }
  async update(contents: string, _version: number, change?: DocumentChange) {
    if (!this.opened || !change) {
      await this.server.request("open", {
        file: this.file,
        fileContent: contents,
        projectRootPath: this.root,
      });
      this.opened = true;
    } else {
      await this.server.request("updateOpen", {
        changedFiles: [
          {
            fileName: this.file,
            textChanges: [
              {
                start: positionAt(this.contents, change.start),
                end: positionAt(this.contents, change.start + change.deleteLength),
                newText: change.text,
              },
            ],
          },
        ],
      });
    }
    this.contents = contents;
  }
  async query(input: LanguageRequest): Promise<LanguageResult> {
    const args = {
      file: this.file,
      line: input.position?.line ?? 1,
      offset: input.position?.column ?? 1,
    };
    const request = (command: string, extra?: object) =>
      this.server.request(command, { ...args, ...extra });
    const location = (item: typeof FileSpan.Type) => {
      const relative = NodePath.relative(this.root, item.file);
      return {
        path:
          relative === ".." ||
          relative.startsWith(`..${NodePath.sep}`) ||
          NodePath.isAbsolute(relative)
            ? item.file
            : relative.replaceAll(NodePath.sep, "/"),
        range: range(item),
        ...(item.lineText === undefined ? {} : { preview: item.lineText.trim() }),
      };
    };
    switch (input.operation) {
      case "completions": {
        const raw = await request("completionInfo", {
          includeExternalModuleExports: false,
          includeInsertTextCompletions: true,
        });
        if (!raw) return { _tag: "completions", items: [] };
        const info = decodeCompletions(raw);
        return {
          _tag: "completions",
          items: info.entries.slice(0, 1000).map((entry) => {
            const span = entry.replacementSpan ?? info.optionalReplacementSpan;
            return {
              label: entry.name,
              kind: entry.kind,
              sortText: entry.sortText,
              insertText: entry.insertText ?? entry.name,
              ...(span ? { range: range(span) } : {}),
            };
          }),
        };
      }
      case "hover": {
        const raw = await request("quickinfo");
        if (!raw) return { _tag: "hover", info: null };
        const info = decodeHover(raw);
        return {
          _tag: "hover",
          info: {
            range: range(info),
            display: info.displayString,
            documentation: display(info.documentation),
            // JSDoc is Markdown, as editors render it.
            markdown: true,
          },
        };
      }
      case "definition": {
        const items = decodeLocations((await request("definition")) ?? []);
        return { _tag: "locations", items: items.slice(0, 200).map(location) };
      }
      case "references": {
        const raw = await request("references");
        const items = raw ? decodeReferences(raw).refs : [];
        return { _tag: "locations", items: items.slice(0, 1000).map(location) };
      }
      case "refresh":
      case "diagnostics": {
        if (input.operation === "refresh") await this.server.request("reloadProjects", {});
        const syntax = decodeDiagnostics((await request("syntacticDiagnosticsSync")) ?? []);
        const semantic = decodeDiagnostics((await request("semanticDiagnosticsSync")) ?? []);
        return {
          _tag: "diagnostics",
          items: [...syntax, ...semantic].slice(0, 500).map((item) => ({
            range: range(item),
            message: item.text,
            severity: item.category,
            code: item.code,
          })),
        };
      }
      case "signature": {
        const raw = await request("signatureHelp");
        if (!raw) return { _tag: "signature", items: [], activeSignature: 0, activeParameter: 0 };
        const info = decodeSignatures(raw);
        return {
          _tag: "signature",
          activeSignature: info.selectedItemIndex,
          activeParameter: info.argumentIndex,
          items: info.items.map((item) => ({
            label:
              display(item.prefixDisplayParts) +
              item.parameters
                .map((parameter) => display(parameter.displayParts))
                .join(display(item.separatorDisplayParts)) +
              display(item.suffixDisplayParts),
            documentation: display(item.documentation),
            parameters: item.parameters.map((parameter) => ({
              label: display(parameter.displayParts),
              documentation: display(parameter.documentation),
            })),
          })),
        };
      }
      case "format": {
        const edits = decodeTextEdits(
          (await request("format", {
            line: 1,
            offset: 1,
            endLine: positionAt(this.contents, this.contents.length).line,
            endOffset: positionAt(this.contents, this.contents.length).offset,
            options: {
              tabSize: 2,
              indentSize: 2,
              convertTabsToSpaces: true,
              newLineCharacter: "\n",
            },
          })) ?? [],
        );
        return {
          _tag: "format",
          edits: edits.map((edit) => ({ range: range(edit), text: edit.newText })),
        };
      }
      case "close":
        return { _tag: "closed" };
    }
  }
}
