// @effect-diagnostics globalTimers:off -- This Node adapter owns and clears language-server request deadlines.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node.js";
import type { CodeDiagnostic, LanguageRequest, LanguageResult } from "@t3tools/contracts";
import type { LanguageBackend } from "./LanguageBackend.ts";
import { LSP_SERVERS, type LanguageServerLaunch, type LspServerId } from "./languageServers.ts";
import {
  codeLocation,
  codeRange,
  completionResult,
  diagnosticResults,
  formattingResult,
} from "./languageResults.ts";
import {
  decodeCompletion,
  decodeConfiguration,
  decodeEdits,
  decodeHover,
  decodeInitialize,
  decodeLocations,
  decodePublishedDiagnostics,
  decodePulledDiagnostics,
  decodeServerStatus,
  decodeSignature,
  markupText,
  hoverMarkdown,
} from "./lspSchemas.ts";

const rustSettings = {
  cargo: { buildScripts: { enable: false } },
  procMacro: { enable: false },
  checkOnSave: false,
  completion: { autoimport: { enable: false } },
};

/** One LSP process per editor preserves the same unsaved-buffer isolation as TypeScript. */
export class LspLanguageBackend implements LanguageBackend {
  private readonly child;
  private readonly connection;
  private readonly initialized: Promise<void>;
  private uri: string;
  private readonly waiters = new Set<() => void>();
  private readonly deadlines = new Set<ReturnType<typeof setTimeout>>();
  private capabilities: Record<string, unknown> = {};
  private version = 0;
  private contents = "";
  private opened = false;
  private quiescent = false;
  private failure: Error | undefined;
  private diagnostics: { version: number; items: CodeDiagnostic[] } | undefined;
  closed = false;
  private readonly root: string;
  private readonly language: LspServerId;

  constructor(root: string, file: string, language: LspServerId, launch: LanguageServerLaunch) {
    this.root = root;
    this.language = language;
    this.uri = NodeURL.pathToFileURL(file).href;
    const server = LSP_SERVERS[language];
    const command = launch.builtIn ? `built-in ${server.name}` : launch.command;
    this.child = NodeChildProcess.spawn(launch.command, launch.args, {
      cwd: root,
      ...(launch.builtIn
        ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" } }
        : {}),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
    );
    let stderr = "";
    this.child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2048);
    });
    this.child.on("error", () =>
      this.stop(
        new Error(
          `${server.label} language features require ${server.name} (${command}) on the connected environment. ${server.installHint} Or set its path in Settings → Code intelligence, then Retry.`,
        ),
      ),
    );
    this.child.on("exit", () =>
      this.stop(
        new Error(
          `${server.name} exited.${stderr ? ` ${stderr.trim()}` : " Retry to restart language features."}`,
        ),
      ),
    );
    this.connection.onError(([error]) => this.stop(error));
    // stdout closes before the exit event; let the exit handler report stderr instead.
    this.connection.onClose(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) return;
      this.stop(new Error("Language server connection closed. Retry to restart."));
    });
    this.connection.onRequest("workspace/configuration", (raw: unknown) =>
      decodeConfiguration(raw).items.map(() => (language === "rust" ? rustSettings : {})),
    );
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("workspace/applyEdit", () => ({
      applied: false,
      failureReason: "Workspace edits must be initiated from the editor.",
    }));
    this.connection.onNotification("experimental/serverStatus", (raw: unknown) => {
      try {
        this.quiescent = decodeServerStatus(raw).quiescent;
        this.signal();
      } catch {
        /* Other servers may use this experimental method differently. */
      }
    });
    this.connection.onNotification("textDocument/publishDiagnostics", (raw: unknown) => {
      try {
        const published = decodePublishedDiagnostics(raw);
        if (
          published.uri !== this.uri ||
          (published.version !== undefined && published.version !== this.version)
        )
          return;
        this.diagnostics = {
          version: this.version,
          items: diagnosticResults(
            published.diagnostics.map((item) => ({ ...item })),
            server.label,
          ),
        };
        this.signal();
      } catch (error) {
        this.stop(
          error instanceof Error ? error : new Error("Invalid language-server diagnostics."),
        );
      }
    });
    this.connection.listen();
    this.initialized = new Promise<void>((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", () =>
        reject(this.failure ?? new Error("Language server failed to start.")),
      );
    }).then(() => this.initialize());
    void this.initialized.catch(() => undefined);
  }

  private async initialize() {
    const rootUri = NodeURL.pathToFileURL(this.root).href;
    const result = decodeInitialize(
      await this.request("initialize", {
        processId: null,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: NodePath.basename(this.root) }],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { configuration: true, workspaceFolders: true },
          window: { workDoneProgress: true },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            completion: { completionItem: { snippetSupport: false }, contextSupport: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            signatureHelp: {
              signatureInformation: { parameterInformation: { labelOffsetSupport: true } },
            },
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: false },
          },
          experimental: { serverStatusNotification: true },
        },
        initializationOptions: this.language === "rust" ? rustSettings : {},
      }),
    );
    this.capabilities = result.capabilities;
    await this.connection.sendNotification("initialized", {});
    await this.connection.sendNotification("workspace/didChangeConfiguration", {
      settings: this.language === "rust" ? { "rust-analyzer": rustSettings } : {},
    });
  }

  private signal() {
    for (const waiter of this.waiters) waiter();
  }
  private waitUntil(predicate: () => boolean, message: string): Promise<void> {
    if (this.closed) return Promise.reject(this.failure ?? new Error("Language server closed."));
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (!this.closed && !predicate()) return;
        clearTimeout(timer);
        this.deadlines.delete(timer);
        this.waiters.delete(finish);
        if (this.closed) reject(this.failure ?? new Error("Language server closed."));
        else resolve();
      };
      const timer = setTimeout(() => {
        this.deadlines.delete(timer);
        this.waiters.delete(finish);
        reject(new Error(message));
      }, 30_000);
      timer.unref();
      this.deadlines.add(timer);
      this.waiters.add(finish);
    });
  }
  private request(method: string, params: object): Promise<unknown> {
    if (this.closed) return Promise.reject(this.failure ?? new Error("Language server closed."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.deadlines.delete(timer);
        const error = new Error(`Language-server request timed out (${method}). Retry to restart.`);
        this.stop(error);
        reject(error);
      }, 30_000);
      timer.unref();
      this.deadlines.add(timer);
      this.connection
        .sendRequest<unknown>(method, params)
        .then(resolve, (error) => reject(this.failure ?? error))
        .finally(() => {
          clearTimeout(timer);
          this.deadlines.delete(timer);
        });
    });
  }
  async retarget(file: string) {
    await this.initialized;
    if (this.opened)
      await this.connection.sendNotification("textDocument/didClose", {
        textDocument: { uri: this.uri },
      });
    this.uri = NodeURL.pathToFileURL(file).href;
    this.opened = false;
    this.contents = "";
    this.diagnostics = undefined;
  }
  async update(contents: string, version: number) {
    await this.initialized;
    if (this.opened && this.version === version && this.contents === contents) return;
    this.version = version;
    this.contents = contents;
    this.diagnostics = undefined;
    if (!this.opened) {
      await this.connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: this.uri,
          languageId: LSP_SERVERS[this.language].languageId,
          version,
          text: contents,
        },
      });
      this.opened = true;
    } else
      await this.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri: this.uri, version },
        contentChanges: [{ text: contents }],
      });
  }

  async query(input: LanguageRequest): Promise<LanguageResult> {
    await this.initialized;
    if (this.language === "rust")
      await this.waitUntil(
        () => this.quiescent,
        "Rust is still loading the workspace. Retry when Cargo finishes resolving the project.",
      );
    const position = {
      line: (input.position?.line ?? 1) - 1,
      character: (input.position?.column ?? 1) - 1,
    };
    const params = { textDocument: { uri: this.uri }, position };
    switch (input.operation) {
      case "completions": {
        if (!this.capabilities.completionProvider) return { _tag: "completions", items: [] };
        const raw = await this.request("textDocument/completion", {
          ...params,
          context: { triggerKind: 1 },
        });
        if (!raw) return { _tag: "completions", items: [] };
        const result = decodeCompletion(raw);
        const items = "items" in result ? result.items : result;
        return completionResult(
          items.map((item) => ({
            ...item,
            ...(item.additionalTextEdits
              ? { additionalTextEdits: [...item.additionalTextEdits] }
              : {}),
          })),
        );
      }
      case "hover": {
        if (!this.capabilities.hoverProvider) return { _tag: "hover", info: null };
        const raw = await this.request("textDocument/hover", params);
        if (!raw) return { _tag: "hover", info: null };
        const hover = decodeHover(raw);
        const parts =
          typeof hover.contents === "string" || "value" in hover.contents
            ? [hover.contents]
            : hover.contents;
        return {
          _tag: "hover",
          info: {
            range: codeRange(hover.range ?? { start: position, end: position }),
            display: "",
            documentation: parts.map(hoverMarkdown).join("\n\n"),
            markdown: !(
              typeof hover.contents === "object" &&
              "kind" in hover.contents &&
              hover.contents.kind === "plaintext"
            ),
          },
        };
      }
      case "definition":
      case "references": {
        if (
          !this.capabilities[
            input.operation === "definition" ? "definitionProvider" : "referencesProvider"
          ]
        )
          return { _tag: "locations", items: [] };
        const raw = await this.request(`textDocument/${input.operation}`, {
          ...params,
          ...(input.operation === "references" ? { context: { includeDeclaration: true } } : {}),
        });
        if (!raw) return { _tag: "locations", items: [] };
        const parsed = decodeLocations(raw);
        const values = "uri" in parsed || "targetUri" in parsed ? [parsed] : parsed;
        return {
          _tag: "locations",
          items: values.slice(0, 1000).flatMap((item) => {
            const result =
              "uri" in item
                ? codeLocation(this.root, item.uri, item.range)
                : codeLocation(this.root, item.targetUri, item.targetSelectionRange);
            return result ? [result] : [];
          }),
        };
      }
      case "signature": {
        const empty: LanguageResult = {
          _tag: "signature",
          items: [],
          activeSignature: 0,
          activeParameter: 0,
        };
        if (!this.capabilities.signatureHelpProvider) return empty;
        const raw = await this.request("textDocument/signatureHelp", params);
        if (!raw) return empty;
        const result = decodeSignature(raw);
        return {
          _tag: "signature",
          activeSignature: result.activeSignature ?? 0,
          activeParameter: result.activeParameter ?? 0,
          items: result.signatures.map((item) => ({
            label: item.label,
            documentation: markupText(item.documentation),
            parameters: (item.parameters ?? []).map((parameter) => ({
              label:
                typeof parameter.label === "string"
                  ? parameter.label
                  : item.label.slice(parameter.label[0], parameter.label[1]),
              documentation: markupText(parameter.documentation),
            })),
          })),
        };
      }
      case "format": {
        if (!this.capabilities.documentFormattingProvider) return { _tag: "format", edits: [] };
        return formattingResult([
          ...decodeEdits(
            (await this.request("textDocument/formatting", {
              textDocument: params.textDocument,
              options: { tabSize: LSP_SERVERS[this.language].tabSize, insertSpaces: true },
            })) ?? [],
          ),
        ]);
      }
      case "refresh":
      case "diagnostics": {
        if (input.operation === "refresh" && this.language === "rust")
          await this.request("rust-analyzer/reloadWorkspace", {});
        if (this.capabilities.diagnosticProvider) {
          const result = decodePulledDiagnostics(
            await this.request("textDocument/diagnostic", { textDocument: params.textDocument }),
          );
          return {
            _tag: "diagnostics",
            items: diagnosticResults(
              result.items.map((item) => ({ ...item })),
              LSP_SERVERS[this.language].label,
            ),
          };
        }
        await this.waitUntil(
          () => this.diagnostics?.version === this.version,
          "The language server has not returned diagnostics yet. Retry to check this file.",
        );
        return { _tag: "diagnostics", items: this.diagnostics?.items ?? [] };
      }
      case "close":
        return { _tag: "closed" };
    }
  }
  private stop(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const timer of this.deadlines) clearTimeout(timer);
    this.deadlines.clear();
    this.signal();
    this.waiters.clear();
    this.connection.dispose();
    this.child.kill();
  }
  dispose() {
    this.stop();
  }
}
