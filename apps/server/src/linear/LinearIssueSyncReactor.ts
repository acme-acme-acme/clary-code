import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type ThreadLinearIssueLink,
  type ThreadLinearIssueSnapshot,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeLinearApi, type LinearIssue } from "./LinearApi.ts";

const SLOW_SYNC_INTERVAL_MS = 15 * 60 * 1_000;

interface LinkEntry {
  readonly thread: OrchestrationV2ThreadShell;
  readonly link: ThreadLinearIssueLink;
}

/** Stable across identifier changes once the first sync has recorded the issue UUID. */
function linkKey(link: ThreadLinearIssueLink): string {
  return link.issueId ?? link.identifier;
}

function isTerminal(link: ThreadLinearIssueLink): boolean {
  const type = link.snapshot?.state.type;
  return type === "completed" || type === "canceled";
}

function isUnsettled(thread: OrchestrationV2ThreadShell): boolean {
  return thread.settledOverride !== "settled" && thread.settledAt === null;
}

type SnapshotFields = Omit<ThreadLinearIssueSnapshot, "syncedAt">;

function snapshotFieldsOf(issue: LinearIssue): SnapshotFields {
  return {
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state,
    assignee: issue.assignee,
    updatedAt: issue.updatedAt,
  };
}

function snapshotChanged(link: ThreadLinearIssueLink, issue: LinearIssue): boolean {
  const current = link.snapshot;
  return (
    current === null ||
    link.issueId !== issue.id ||
    link.url !== issue.url ||
    current.identifier !== issue.identifier ||
    current.title !== issue.title ||
    current.state.name !== issue.state.name ||
    current.state.type !== issue.state.type ||
    current.state.color !== issue.state.color ||
    current.assignee !== issue.assignee ||
    current.updatedAt !== issue.updatedAt
  );
}

/**
 * Keeps every thread ↔ Linear issue link's status current, the way
 * PullRequestSyncReactor does for pull requests. One sweep a minute reads
 * the shell snapshot, reads every due issue in batched GraphQL requests, and
 * writes back only what changed. Does nothing until a Linear API key is set.
 */
export class LinearIssueSyncReactor extends Context.Service<
  LinearIssueSyncReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    /** Sync now instead of waiting for the next sweep, e.g. after a new link. */
    readonly requestSync: Effect.Effect<void>;
  }
>()("t3/linear/LinearIssueSyncReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestratorV2;
  const settingsService = yield* ServerSettingsService;
  const api = yield* makeLinearApi;
  const crypto = yield* Crypto.Crypto;
  const lastSyncedAt = new Map<string, number>();

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(message, fields);

  const isDue = (key: string, entries: ReadonlyArray<LinkEntry>, nowMs: number): boolean => {
    if (entries.some((entry) => entry.link.snapshot === null)) return true;
    if (entries.some((entry) => !isTerminal(entry.link) && isUnsettled(entry.thread))) return true;
    const last = lastSyncedAt.get(key);
    return last === undefined || nowMs - last >= SLOW_SYNC_INTERVAL_MS;
  };

  const sweep = Effect.fn("LinearIssueSyncReactor.sweep")(function* () {
    const settings = yield* settingsService.getSettings;
    const apiKey = settings.linear.apiKey;
    if (apiKey.length === 0) return;
    const snapshot = yield* engine.getShellSnapshot();
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);

    const groups = new Map<string, Array<LinkEntry>>();
    for (const thread of snapshot.threads) {
      if (thread.archivedAt !== null) continue;
      for (const link of thread.linearIssues ?? []) {
        const key = linkKey(link);
        const entries = groups.get(key) ?? [];
        entries.push({ thread, link });
        groups.set(key, entries);
      }
    }
    for (const key of lastSyncedAt.keys()) if (!groups.has(key)) lastSyncedAt.delete(key);

    const due = [...groups].filter(([key, entries]) => isDue(key, entries, nowMs));
    if (due.length === 0) return;
    const issues = yield* api.readIssues(
      apiKey,
      due.map(([key]) => key),
    );
    const syncedAt = DateTime.formatIso(now);
    for (const [key, entries] of due) {
      lastSyncedAt.set(key, nowMs);
      const issue = issues.get(key);
      if (!issue) continue;
      for (const entry of entries) {
        if (!snapshotChanged(entry.link, issue)) continue;
        const uuid = yield* crypto.randomUUIDv4;
        yield* engine
          .dispatch({
            type: "thread.linear-issue-link.sync",
            commandId: CommandId.make(`server:linear-sync:${entry.thread.id}:${uuid}`),
            threadId: entry.thread.id,
            identifier: entry.link.identifier,
            issueId: issue.id,
            url: issue.url,
            snapshot: { ...snapshotFieldsOf(issue), syncedAt },
          })
          .pipe(
            Effect.catchCause(
              logSkipped("linear issue sync skipped", { threadId: entry.thread.id, key }),
            ),
          );
      }
    }
  });

  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(Effect.catchCause(logSkipped("linear issue sync sweep failed", {}))),
  );

  const requestSync = worker.enqueue(undefined);

  const start: LinearIssueSyncReactor["Service"]["start"] = Effect.fn(
    "LinearIssueSyncReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "thread.pull-request-synced" &&
        (event.payload.linearIssues ?? []).some((link) => link.snapshot === null)
          ? requestSync
          : Effect.void,
      ).pipe(Effect.catchCause(logSkipped("linear issue sync event stream failed", {}))),
    );
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });

  return { start, drain: worker.drain, requestSync } satisfies LinearIssueSyncReactor["Service"];
});

export const layer = Layer.effect(LinearIssueSyncReactor, make);
