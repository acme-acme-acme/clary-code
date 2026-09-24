import {
  CommandId,
  linearIssueUrl,
  parseLinearIssueReference,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  LinearIssueLinkFailedError,
  LinearIssueReferenceInvalidError,
  LinearIssueThreadNotFoundError,
  LinearIssuesToolkit,
  type LinearIssueTargetInput,
} from "./tools.ts";

const make = Effect.gen(function* () {
  const engine = yield* OrchestratorV2;
  const crypto = yield* Crypto.Crypto;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const requireThread = Effect.fn("LinearIssuesToolkit.requireThread")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const thread = yield* engine
      .getThreadShell(scope.threadId)
      .pipe(Effect.mapError((cause) => new LinearIssueLinkFailedError({ cause })));
    if (!thread) return yield* new LinearIssueThreadNotFoundError({ threadId: scope.threadId });
    return thread;
  });

  const resolve = (input: LinearIssueTargetInput) => {
    const parsed = parseLinearIssueReference(input.issue);
    return parsed === null
      ? Effect.fail(new LinearIssueReferenceInvalidError({}))
      : Effect.succeed(parsed);
  };

  const dispatchFailure = <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new LinearIssueLinkFailedError({ cause }));

  return LinearIssuesToolkit.of({
    link_linear_issue: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread();
        const target = yield* resolve(input);
        if ((thread.linearIssues ?? []).some((link) => link.identifier === target.identifier)) {
          return { identifier: target.identifier, alreadyLinked: true };
        }
        yield* engine
          .dispatch({
            type: "thread.linear-issue.link",
            commandId: yield* commandId("mcp-linear-link", thread.id),
            threadId: thread.id,
            identifier: target.identifier,
            url: target.url ?? linearIssueUrl(target.identifier),
            source: "agent",
          })
          .pipe(Effect.catchCause(dispatchFailure));
        return { identifier: target.identifier, alreadyLinked: false };
      }),
    unlink_linear_issue: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread();
        const target = yield* resolve(input);
        if (!(thread.linearIssues ?? []).some((link) => link.identifier === target.identifier)) {
          return { identifier: target.identifier, wasLinked: false };
        }
        yield* engine
          .dispatch({
            type: "thread.linear-issue.unlink",
            commandId: yield* commandId("mcp-linear-unlink", thread.id),
            threadId: thread.id,
            identifier: target.identifier,
          })
          .pipe(Effect.catchCause(dispatchFailure));
        return { identifier: target.identifier, wasLinked: true };
      }),
    list_thread_linear_issues: () =>
      Effect.gen(function* () {
        const thread = yield* requireThread();
        return {
          issues: (thread.linearIssues ?? []).map((link) => ({
            identifier: link.identifier,
            url: link.url,
            source: link.source,
            title: link.snapshot?.title ?? null,
            state: link.snapshot?.state.name ?? null,
            stateType: link.snapshot?.state.type ?? null,
          })),
        };
      }),
  });
});

export const LinearIssuesToolkitHandlersLive = LinearIssuesToolkit.toLayer(make);
