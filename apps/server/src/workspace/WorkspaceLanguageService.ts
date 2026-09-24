// @effect-diagnostics globalTimers:off -- This Node process adapter owns and clears its request and idle deadlines.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  codeIntelligenceServerForLanguage,
  LanguageServiceError,
  type CodeIntelligenceServerId,
  type CodeIntelligenceSettings,
  type LanguageRequest,
  type LanguageResult,
} from "@t3tools/contracts";
import { TypeScriptLanguageBackend } from "./TypeScriptLanguageBackend.ts";
import { JsonLanguageBackend } from "./JsonLanguageBackend.ts";
import { LspLanguageBackend } from "./LspLanguageBackend.ts";
import type { LanguageBackend } from "./LanguageBackend.ts";
import { codeLanguageForPath } from "@t3tools/contracts";
import {
  isLanguageServerEnabled,
  languageServerLaunch,
  launchKey,
  LSP_SERVERS,
  type LanguageServerLaunch,
} from "./languageServers.ts";

type CodeLanguage = NonNullable<ReturnType<typeof codeLanguageForPath>>;
interface Target {
  root: string;
  file: string;
  language: CodeLanguage;
}

/** What an LSP kind would launch; null for the in-process TypeScript and JSON services. */
const launchFor = (kind: CodeIntelligenceServerId, settings: CodeIntelligenceSettings) =>
  kind === "typescript" || kind === "json" ? null : languageServerLaunch(kind, settings);
const keyOf = (launch: LanguageServerLaunch | null) => (launch ? launchKey(launch) : null);

function createBackend(
  { root, file, language }: Target,
  launch: LanguageServerLaunch | null,
): LanguageBackend {
  return language === "typescript" || language === "javascript"
    ? new TypeScriptLanguageBackend(root, file)
    : language === "json" || language === "jsonc"
      ? new JsonLanguageBackend(root, file, language)
      : new LspLanguageBackend(root, file, language, launch!);
}

function assertEnabled(kind: CodeIntelligenceServerId, settings: CodeIntelligenceSettings) {
  if (isLanguageServerEnabled(kind, settings)) return;
  const label =
    kind === "typescript" ? "TypeScript" : kind === "json" ? "JSON" : LSP_SERVERS[kind].label;
  throw new LanguageServiceError({
    message: `${label} language features are turned off in Settings → Code intelligence.`,
    resync: false,
  });
}

interface EditorSession {
  server: LanguageBackend;
  kind: CodeIntelligenceServerId;
  launch: LanguageServerLaunch | null;
  cwd: string;
  file: string;
  contents: string;
  version: number;
  tail: Promise<unknown>;
  idle: ReturnType<typeof setTimeout> | undefined;
}

/** Connection-scoped, with separate unsaved buffers for each editor. Nothing is written to disk. */
export class WorkspaceLanguageService {
  private readonly sessions = new Map<string, EditorSession>();
  private disposed = false;

  /** `settings` is read per request so Settings changes apply without reconnecting. */
  async request(
    input: LanguageRequest,
    settings: CodeIntelligenceSettings = {},
  ): Promise<LanguageResult> {
    if (this.disposed)
      throw new LanguageServiceError({ message: "Connection closed.", resync: false });
    let session = this.sessions.get(input.sessionId);
    if (input.operation === "close") {
      if (session) this.remove(input.sessionId, session);
      return { _tag: "closed" };
    }
    if (session?.server.closed) {
      this.remove(input.sessionId, session);
      session = undefined;
    }
    if (session && keyOf(launchFor(session.kind, settings)) !== keyOf(session.launch)) {
      // A new path from Settings takes effect on the next open.
      this.remove(input.sessionId, session);
      session = undefined;
    }
    if (!session) {
      if (input.update?._tag !== "open")
        throw new LanguageServiceError({ message: "Editor session expired.", resync: true });
      const target = await this.resolve(input);
      const kind = codeIntelligenceServerForLanguage(target.language);
      assertEnabled(kind, settings);
      // Recheck after filesystem awaits; simultaneous opens must not orphan a process.
      session = this.sessions.get(input.sessionId);
      if (!session) {
        if (this.sessions.size >= 4)
          throw new Error("Too many active code editors. Close an editor and retry.");
        const launch = launchFor(kind, settings);
        session = {
          server: createBackend(target, launch),
          kind,
          launch,
          cwd: input.cwd,
          file: target.file,
          contents: "",
          version: -1,
          tail: Promise.resolve(),
          idle: undefined,
        };
        this.sessions.set(input.sessionId, session);
      }
    }
    const current = session;
    let retarget: Target | undefined;
    if (
      current.cwd !== input.cwd ||
      NodePath.resolve(input.cwd, input.relativePath) !== current.file
    ) {
      // realpath may have resolved a symlink within the workspace.
      const target = await this.resolve(input);
      if (current.cwd !== input.cwd || target.file !== current.file) {
        // A diff viewer reuses one session as the pointer moves between files.
        if (input.update?._tag !== "open")
          throw new LanguageServiceError({
            message: "Editor moved to another file. Resynchronizing.",
            resync: true,
          });
        retarget = target;
      }
    }
    assertEnabled(
      retarget ? codeIntelligenceServerForLanguage(retarget.language) : current.kind,
      settings,
    );
    clearTimeout(current.idle);
    const task = current.tail.then(async () => {
      if (retarget) await this.retarget(current, input.cwd, retarget, settings);
      await this.synchronize(current, input);
      if (input.operation === "refresh" && codeLanguageForPath(current.file) === "protobuf") {
        // Buf caches imported files for the process lifetime. Reload only on workspace changes.
        current.server.dispose();
        current.server = new LspLanguageBackend(
          await NodeFSP.realpath(current.cwd),
          current.file,
          "protobuf",
          current.launch!,
        );
        await current.server.update(current.contents, current.version);
      }
      return current.server.query(input);
    });
    current.tail = task.catch(() => undefined);
    try {
      return await task;
    } finally {
      if (this.sessions.get(input.sessionId) === current) {
        clearTimeout(current.idle);
        current.idle = setTimeout(() => this.remove(input.sessionId, current), 5 * 60_000);
        current.idle.unref();
      }
    }
  }

  private async resolve(input: LanguageRequest): Promise<Target> {
    const language = codeLanguageForPath(input.relativePath);
    if (!language) throw new Error("Language features are not available for this file type.");
    const root = await NodeFSP.realpath(input.cwd);
    const file = await NodeFSP.realpath(NodePath.resolve(root, input.relativePath));
    const relative = NodePath.relative(root, file);
    if (
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    )
      throw new Error("Editor file must be inside the workspace.");
    if (this.disposed) throw new Error("Connection closed.");
    return { root, file, language };
  }

  /** Keeps a warm language process when the next file uses the same one. */
  private async retarget(
    session: EditorSession,
    cwd: string,
    target: Target,
    settings: CodeIntelligenceSettings,
  ) {
    const kind = codeIntelligenceServerForLanguage(target.language);
    const launch = launchFor(kind, settings);
    if (
      session.cwd === cwd &&
      session.kind === kind &&
      keyOf(session.launch) === keyOf(launch) &&
      session.server.retarget
    ) {
      await session.server.retarget(target.file);
    } else {
      session.server.dispose();
      session.server = createBackend(target, launch);
    }
    session.launch = launch;
    session.kind = kind;
    session.cwd = cwd;
    session.file = target.file;
    session.contents = "";
    session.version = -1;
  }

  private async synchronize(session: EditorSession, input: LanguageRequest) {
    const update = input.update;
    if (update?._tag === "open") {
      await session.server.update(update.contents, input.version);
      session.contents = update.contents;
      session.version = input.version;
    } else if (update?._tag === "change") {
      if (update.baseVersion !== session.version || input.version <= session.version)
        throw new LanguageServiceError({
          message: "Editor changed. Resynchronizing.",
          resync: true,
        });
      if (update.start + update.deleteLength > session.contents.length)
        throw new Error("Invalid editor change range.");
      const contents =
        session.contents.slice(0, update.start) +
        update.text +
        session.contents.slice(update.start + update.deleteLength);
      if (contents.length > 1024 * 1024)
        throw new Error("File is too large for language features.");
      await session.server.update(contents, input.version, update);
      session.contents = contents;
      session.version = input.version;
    } else if (input.version !== session.version) {
      throw new LanguageServiceError({ message: "Editor changed. Resynchronizing.", resync: true });
    }
  }

  private remove(id: string, session: EditorSession) {
    clearTimeout(session.idle);
    session.server.dispose();
    if (this.sessions.get(id) === session) this.sessions.delete(id);
  }

  dispose() {
    this.disposed = true;
    for (const [id, session] of this.sessions) this.remove(id, session);
  }
}
