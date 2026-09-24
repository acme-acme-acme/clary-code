import {
  CommandId,
  type LinearIssueChange,
  type LinearIssueDetail,
  LinearIssueDetailError,
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
import { makeLinearApi, type LinearIssue } from "./LinearApi.ts";
import { makeLinearCredentials } from "./LinearCredentials.ts";
import { makeLinearLiveFeed } from "./LinearLiveFeed.ts";

const SLOW_SYNC_INTERVAL_MS = 15 * 60 * 1_000;
/**
 * Linear's live feed triggers a sweep as soon as a linked issue changes. While
 * it is live, sweeps re-read only active issues; while it is down, every
 * linked issue, in batches of 50 per request.
 */
const SYNC_INTERVAL = "30 seconds";

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

export function issueOfDetail(detail: LinearIssueDetail): LinearIssue {
  return {
    id: detail.id,
    identifier: detail.identifier,
    title: detail.title,
    url: detail.url,
    updatedAt: detail.updatedAt,
    state: detail.state,
    assignee: detail.assignee?.name ?? null,
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
    current.state.progress !== issue.state.progress ||
    current.assignee !== issue.assignee ||
    current.updatedAt !== issue.updatedAt
  );
}

/**
 * Keeps every thread ↔ Linear issue link's status current, the way
 * PullRequestSyncReactor does for pull requests. Each sweep reads
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
    /** Issues changing in Linear, pushed by its live feed; any issue in the workspace. */
    readonly issueChanges: Stream.Stream<LinearIssueChange>;
    /** One issue for the Linear issue page, read live with this environment's API key. */
    readonly readIssueDetail: (
      reference: string,
    ) => Effect.Effect<LinearIssueDetail, LinearIssueDetailError>;
  }
>()("t3/linear/LinearIssueSyncReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestratorV2;
  const api = yield* makeLinearApi;
  const crypto = yield* Crypto.Crypto;
  const lastSyncedAt = new Map<string, number>();
  /** Every linked issue's UUID and identifier, so feed events for other issues are ignored. */
  let linkedReferences = new Set<string>();
  const credentials = yield* makeLinearCredentials;
  const liveFeed = yield* makeLinearLiveFeed(credentials.both);

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(message, fields);

  const isDue = (
    key: string,
    entries: ReadonlyArray<LinkEntry>,
    nowMs: number,
    live: boolean,
  ): boolean => {
    // Without the live feed, polling is the only way changes arrive: read every issue.
    if (!live || entries.some((entry) => entry.link.snapshot === null)) return true;
    if (entries.some((entry) => !isTerminal(entry.link) && isUnsettled(entry.thread))) return true;
    const last = lastSyncedAt.get(key);
    return last === undefined || nowMs - last >= SLOW_SYNC_INTERVAL_MS;
  };

  const sweep = Effect.fn("LinearIssueSyncReactor.sweep")(function* () {
    const credential = yield* credentials.current;
    if (credential === null) return;
    const apiKey = credential.token;
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
    linkedReferences = new Set(
      [...groups.values()].flatMap((entries) =>
        entries.flatMap(({ link }) => [link.identifier, ...(link.issueId ? [link.issueId] : [])]),
      ),
    );

    const live = yield* liveFeed.live;
    const due = [...groups].filter(([key, entries]) => isDue(key, entries, nowMs, live));
    if (due.length === 0) return;
    const issues = yield* api.readIssues(
      apiKey,
      due.map(([key]) => key),
    );
    for (const [key, entries] of due) {
      lastSyncedAt.set(key, nowMs);
      const issue = issues.get(key);
      if (issue) yield* writeSnapshots(entries, issue, now);
    }
  });

  /** Records a freshly read issue on every link to it that shows something else. */
  const writeSnapshots = Effect.fn("LinearIssueSyncReactor.writeSnapshots")(function* (
    entries: ReadonlyArray<LinkEntry>,
    issue: LinearIssue,
    now: DateTime.Utc,
  ) {
    const syncedAt = DateTime.formatIso(now);
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
            logSkipped("linear issue sync skipped", {
              threadId: entry.thread.id,
              key: linkKey(entry.link),
            }),
          ),
        );
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
      }).pipe(Effect.repeat(Schedule.spaced(SYNC_INTERVAL)), Effect.asVoid),
    );
    yield* forkParked(liveFeed.run);
    yield* forkParked(
      Stream.runForEach(liveFeed.changes, (change) => {
        const references = [change.issueId, ...(change.identifier ? [change.identifier] : [])];
        if (!references.some((reference) => linkedReferences.has(reference))) return Effect.void;
        // Due now, even if the issue is done and its thread settled.
        for (const reference of references) lastSyncedAt.delete(reference);
        return requestSync;
      }),
    );
  });

  /** Writes an issue read for its page onto the threads linked to it, like a sweep would. */
  const recordDetail = Effect.fn("LinearIssueSyncReactor.recordDetail")(function* (
    detail: LinearIssueDetail,
  ) {
    const snapshot = yield* engine.getShellSnapshot();
    const entries = snapshot.threads.flatMap((thread) =>
      thread.archivedAt === null
        ? (thread.linearIssues ?? [])
            .filter((link) => link.issueId === detail.id || link.identifier === detail.identifier)
            .map((link) => ({ thread, link }))
        : [],
    );
    const now = yield* DateTime.now;
    yield* writeSnapshots(entries, issueOfDetail(detail), now);
    for (const { link } of entries) lastSyncedAt.set(linkKey(link), DateTime.toEpochMillis(now));
  });

  const readIssueDetail: LinearIssueSyncReactor["Service"]["readIssueDetail"] = Effect.fn(
    "LinearIssueSyncReactor.readIssueDetail",
  )(function* (reference) {
    const credential = yield* credentials.current;
    if (credential === null) {
      return yield* new LinearIssueDetailError({
        reason: "not_configured",
        detail:
          "Connect Linear or add a Linear API key in Settings → Connections → Linear to see issue details.",
      });
    }
    const detail = yield* api
      .readIssueDetail(credential.token, reference, { reviews: credential.kind === "user" })
      .pipe(
        Effect.mapError(
          (error) => new LinearIssueDetailError({ reason: "unavailable", detail: error.detail }),
        ),
      );
    if (detail === null) {
      return yield* new LinearIssueDetailError({
        reason: "not_found",
        detail: `Linear has no issue ${reference}, or this API key can't see it.`,
      });
    }
    // The page and the sidebar show one read: this one also updates every linked thread.
    if (linkedReferences.has(detail.id) || linkedReferences.has(detail.identifier)) {
      yield* recordDetail(detail).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("linear issue sync skipped", {
            key: detail.identifier,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
    return detail;
  });

  return {
    start,
    drain: worker.drain,
    requestSync,
    readIssueDetail,
    issueChanges: liveFeed.changes,
  } satisfies LinearIssueSyncReactor["Service"];
});

export const layer = Layer.effect(LinearIssueSyncReactor, make);
