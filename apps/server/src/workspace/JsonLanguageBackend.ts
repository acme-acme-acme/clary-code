// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off -- The JSON service invokes a Promise-based schema loader outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { getLanguageService, type ASTNode, type JSONDocument } from "vscode-json-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { CodeLocation, LanguageRequest, LanguageResult } from "@t3tools/contracts";
import type { LanguageBackend } from "./LanguageBackend.ts";
import {
  codeLocation,
  codeRange,
  completionResult,
  diagnosticResults,
  formattingResult,
} from "./languageResults.ts";

export class JsonLanguageBackend implements LanguageBackend {
  closed = false;
  private readonly service;
  private document: TextDocument;
  private parsed: JSONDocument;
  private readonly root: string;
  private readonly language: "json" | "jsonc";
  constructor(root: string, file: string, language: "json" | "jsonc") {
    this.root = root;
    this.language = language;
    const uri = NodeURL.pathToFileURL(file).href;
    this.document = TextDocument.create(uri, language, 0, "");
    this.service = getLanguageService({
      clientCapabilities: { textDocument: { hover: { contentFormat: ["plaintext"] } } },
      workspaceContext: {
        resolveRelativePath: (relative, resource) => new URL(relative, resource).href,
      },
      schemaRequestService: async (resource) => {
        if (resource.startsWith("file:"))
          return NodeFSP.readFile(NodeURL.fileURLToPath(resource), "utf8");
        if (!resource.startsWith("https:"))
          throw new Error("JSON schemas must use a local file or HTTPS URL.");
        const response = await fetch(resource, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Unable to load JSON schema (${response.status}).`);
        return response.text();
      },
    });
    this.service.configure({ validate: true, allowComments: language === "jsonc" });
    this.parsed = this.service.parseJSONDocument(this.document);
  }
  async update(contents: string, version: number) {
    this.document = TextDocument.create(this.document.uri, this.language, version, contents);
    this.parsed = this.service.parseJSONDocument(this.document);
  }
  dispose() {
    this.closed = true;
  }

  private async referenceTarget(node: ASTNode | undefined): Promise<CodeLocation[]> {
    if (
      node?.type !== "string" ||
      node.parent?.type !== "property" ||
      node.parent.keyNode.value !== "$ref" ||
      node === node.parent.keyNode
    )
      return [];
    const url = new URL(node.value, this.document.uri);
    if (url.protocol !== "file:") return [];
    const fragment = decodeURIComponent(url.hash.slice(1));
    url.hash = "";
    const document =
      url.href === this.document.uri
        ? this.document
        : TextDocument.create(
            url.href,
            "json",
            0,
            await NodeFSP.readFile(NodeURL.fileURLToPath(url), "utf8"),
          );
    let target = (
      document === this.document ? this.parsed : this.service.parseJSONDocument(document)
    ).root;
    if (fragment && !fragment.startsWith("/")) return [];
    for (const segment of fragment
      ? fragment
          .slice(1)
          .split("/")
          .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      : []) {
      target =
        target?.type === "object"
          ? target.properties.find((property) => property.keyNode.value === segment)?.valueNode
          : target?.type === "array"
            ? target.items[Number(segment)]
            : undefined;
    }
    if (!target) return [];
    const location = codeLocation(this.root, document.uri, {
      start: document.positionAt(target.offset),
      end: document.positionAt(target.offset + target.length),
    });
    return location ? [location] : [];
  }

  async query(input: LanguageRequest): Promise<LanguageResult> {
    const position = {
      line: (input.position?.line ?? 1) - 1,
      character: (input.position?.column ?? 1) - 1,
    };
    switch (input.operation) {
      case "completions":
        return completionResult(
          (await this.service.doComplete(this.document, position, this.parsed))?.items ?? [],
        );
      case "hover": {
        const hover = await this.service.doHover(this.document, position, this.parsed);
        if (!hover) return { _tag: "hover", info: null };
        const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
        return {
          _tag: "hover",
          info: {
            range: codeRange(hover.range ?? { start: position, end: position }),
            display: "",
            markdown: true,
            documentation: contents
              .map((part) => (typeof part === "string" ? part : part.value))
              .join("\n\n"),
          },
        };
      }
      case "definition":
        return {
          _tag: "locations",
          items: await this.referenceTarget(
            this.parsed.getNodeFromOffset(this.document.offsetAt(position)),
          ),
        };
      case "references": {
        const selected = this.parsed.getNodeFromOffset(this.document.offsetAt(position));
        const value =
          selected?.parent?.type === "property" && selected === selected.parent.keyNode
            ? selected.parent.valueNode
            : selected;
        const matches: CodeLocation[] = [];
        const visit = async (node: ASTNode) => {
          if (node.type === "string") {
            const targets = await this.referenceTarget(node);
            if (
              value &&
              targets.some(
                (target) =>
                  target.path ===
                    codeLocation(this.root, this.document.uri, { start: position, end: position })
                      ?.path &&
                  target.range.start.line === this.document.positionAt(value.offset).line + 1 &&
                  target.range.start.column ===
                    this.document.positionAt(value.offset).character + 1,
              )
            ) {
              const location = codeLocation(this.root, this.document.uri, {
                start: this.document.positionAt(node.offset),
                end: this.document.positionAt(node.offset + node.length),
              });
              if (location) matches.push(location);
            }
          }
          for (const child of node.children ?? []) await visit(child);
        };
        if (this.parsed.root) await visit(this.parsed.root);
        return { _tag: "locations", items: matches.slice(0, 1000) };
      }
      case "refresh":
        for (const schema of this.service.getLanguageStatus(this.document, this.parsed).schemas)
          this.service.resetSchema(schema);
      // fall through to validate with reloaded schemas
      case "diagnostics":
        return {
          _tag: "diagnostics",
          items: diagnosticResults(
            await this.service.doValidation(this.document, this.parsed, {
              comments: this.language === "jsonc" ? "ignore" : "error",
              trailingCommas: this.language === "jsonc" ? "ignore" : "error",
            }),
            "JSON",
          ),
        };
      case "format":
        return formattingResult(
          this.service.format(this.document, undefined, { tabSize: 2, insertSpaces: true }),
        );
      case "signature":
        return { _tag: "signature", items: [], activeSignature: 0, activeParameter: 0 };
      case "close":
        return { _tag: "closed" };
    }
  }
}
