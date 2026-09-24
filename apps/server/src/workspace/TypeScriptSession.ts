// @effect-diagnostics globalTimers:off -- This Node process adapter owns and clears its request and idle deadlines.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as Schema from "effect/Schema";

const Response = Schema.Struct({
  type: Schema.String,
  request_seq: Schema.optional(Schema.Number),
  success: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.String),
  body: Schema.optional(Schema.Unknown),
});

const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(Response));

/** Owns exactly one tsserver process; all protocol failures retire that process. */
export class TypeScriptSession {
  private readonly child;
  private buffer: Buffer = Buffer.alloc(0);
  private sequence = 0;
  private stopped = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(cwd: string) {
    // Ship a known protocol version. Workspace tsconfig/jsconfig and dependencies
    // still come from cwd; loading arbitrary workspace plugins is unnecessary.
    const tsserver = NodeModule.createRequire(import.meta.url).resolve(
      "typescript/lib/tsserver.js",
    );
    this.child = NodeChildProcess.spawn(
      process.execPath,
      [tsserver, "--disableAutomaticTypingAcquisition", "--noGetErrOnBackgroundUpdate"],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", TSS_LOG: "" },
      },
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.resume();
    this.child.on("error", (error) => this.dispose(error));
    this.child.stdin.on("error", (error) => this.dispose(error));
    this.child.on("exit", () =>
      this.dispose(new Error("TypeScript language service stopped. Retry to restart it.")),
    );
  }

  get closed() {
    return this.stopped;
  }

  request(command: string, args: unknown): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("TypeScript language service is closed."));
    const seq = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.dispose(new Error("TypeScript language service timed out. Retry to restart it.")),
        30_000,
      );
      timer.unref();
      this.pending.set(seq, { resolve, reject, timer });
      this.child.stdin.write(
        `${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`,
      );
    });
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.dispose(new Error("TypeScript response exceeded the size limit."));
      return;
    }
    try {
      while (true) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const match = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString());
        if (!match) throw new Error("Invalid TypeScript response header.");
        const length = Number(match[1]);
        if (length > 16 * 1024 * 1024)
          throw new Error("TypeScript response exceeded the size limit.");
        if (this.buffer.length < headerEnd + 4 + length) return;
        const response = decodeResponse(
          this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString(),
        );
        this.buffer = this.buffer.subarray(headerEnd + 4 + length);
        if (response.type !== "response" || response.request_seq === undefined) continue;
        const pending = this.pending.get(response.request_seq);
        if (!pending) continue;
        this.pending.delete(response.request_seq);
        clearTimeout(pending.timer);
        if (response.success) pending.resolve(response.body);
        else if (response.message === "No content available.") pending.resolve(undefined);
        else pending.reject(new Error(response.message ?? "TypeScript request failed."));
      }
    } catch (error) {
      this.dispose(error instanceof Error ? error : new Error(String(error)));
    }
  }

  dispose(error = new Error("TypeScript language service closed.")) {
    if (this.stopped) return;
    this.stopped = true;
    this.child.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
  }
}
