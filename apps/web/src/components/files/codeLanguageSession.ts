import * as Schema from "effect/Schema";
import { randomUUID } from "~/lib/utils";
import {
  LanguageServiceError,
  type LanguageRequest,
  type LanguageResult,
} from "@t3tools/contracts";

const isLanguageServiceError = Schema.is(LanguageServiceError);

/** Coalesce a batch of editor changes into one UTF-16 replacement on the wire. */
export function codeTextChange(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return { start, deleteLength: endBefore - start, text: after.slice(start, endAfter) };
}

type Target = { cwd: string; relativePath: string };

/** One server-side editor buffer. A diff viewer moves it between files by naming a target per request. */
export class CodeLanguageSession {
  private readonly sessionId = randomUUID();
  private synced: { target: Target; contents: string; version: number } | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly target: Target,
    private readonly send: (input: LanguageRequest) => Promise<LanguageResult>,
  ) {}

  request(
    document: { contents: string; version: number; target?: Target },
    operation: LanguageRequest["operation"],
    position?: LanguageRequest["position"],
    isCancelled = () => false,
  ): Promise<LanguageResult | undefined> {
    const task = this.tail.then(async () => {
      if (this.disposed || isCancelled()) return;
      const send = async () => {
        const target = document.target ?? this.target;
        const previous =
          this.synced?.target.cwd === target.cwd &&
          this.synced.target.relativePath === target.relativePath
            ? this.synced
            : undefined;
        const update: LanguageRequest["update"] =
          previous === undefined
            ? { _tag: "open", contents: document.contents }
            : previous.version !== document.version
              ? {
                  _tag: "change",
                  baseVersion: previous.version,
                  ...codeTextChange(previous.contents, document.contents),
                }
              : undefined;
        const result = await this.send({
          ...target,
          sessionId: this.sessionId,
          operation,
          version: document.version,
          ...(position ? { position } : {}),
          ...(update ? { update } : {}),
        });
        this.synced = { target, contents: document.contents, version: document.version };
        return result;
      };
      try {
        return await send();
      } catch (error) {
        this.synced = undefined;
        // A reconnect or idle eviction loses the server buffer, not the editor.
        if (isLanguageServiceError(error) && error.resync && !this.disposed && !isCancelled())
          return send();
        throw error;
      }
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  dispose() {
    this.disposed = true;
    void this.tail
      .then(() =>
        this.send({ ...this.target, sessionId: this.sessionId, operation: "close", version: 0 }),
      )
      .catch(() => undefined);
  }
}
