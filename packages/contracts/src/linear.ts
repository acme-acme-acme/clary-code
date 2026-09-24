import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Linear groups workflow states into these fixed types; names and colors are
 * per-team. Unknown future types decode as "unknown" rather than failing.
 */
export const LinearIssueStateType = Schema.Literals([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "unknown",
]);
export type LinearIssueStateType = typeof LinearIssueStateType.Type;

export const LinearIssueState = Schema.Struct({
  name: TrimmedNonEmptyString,
  type: LinearIssueStateType,
  color: Schema.String,
});
export type LinearIssueState = typeof LinearIssueState.Type;

/** Issue state persisted on a link by the sync reactor; null until first sync. */
export const ThreadLinearIssueSnapshot = Schema.Struct({
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  state: LinearIssueState,
  assignee: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: Schema.NullOr(IsoDateTime),
  syncedAt: IsoDateTime,
});
export type ThreadLinearIssueSnapshot = typeof ThreadLinearIssueSnapshot.Type;

/** Who created a thread ↔ Linear issue link. `delegated` means Linear handed
 * the issue to the Otter agent, which started the thread. */
export const ThreadLinearIssueLinkSource = Schema.Literals(["manual", "agent", "delegated"]);
export type ThreadLinearIssueLinkSource = typeof ThreadLinearIssueLinkSource.Type;

/**
 * `identifier` ("ENG-123") is what people type and search, but it changes
 * when an issue moves teams, so links are keyed by it only until the first
 * sync fills in the stable `issueId`.
 */
export const ThreadLinearIssueLink = Schema.Struct({
  identifier: TrimmedNonEmptyString,
  issueId: Schema.NullOr(TrimmedNonEmptyString),
  url: TrimmedNonEmptyString,
  source: ThreadLinearIssueLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadLinearIssueSnapshot),
});
export type ThreadLinearIssueLink = typeof ThreadLinearIssueLink.Type;

const LINEAR_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-[1-9][0-9]*$/u;

/** "eng-123" → "ENG-123"; null when the text is not an issue identifier. */
export function normalizeLinearIssueIdentifier(value: string): string | null {
  const trimmed = value.trim();
  return LINEAR_IDENTIFIER_PATTERN.test(trimmed) ? trimmed.toUpperCase() : null;
}

/** Accepts "ENG-123" or a linear.app issue URL. */
export function parseLinearIssueReference(
  value: string,
): { readonly identifier: string; readonly url: string | null } | null {
  const trimmed = value.trim();
  const identifier = normalizeLinearIssueIdentifier(trimmed);
  if (identifier) return { identifier, url: null };
  const match = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z0-9]+-[0-9]+)(?:[/?#]|$)/u.exec(
    trimmed,
  );
  const fromUrl = match?.[1] ? normalizeLinearIssueIdentifier(match[1]) : null;
  return fromUrl ? { identifier: fromUrl, url: trimmed.split(/[?#]/u)[0]! } : null;
}

/** Workspace-less issue URL for links made before the first sync fills in the real one. */
export function linearIssueUrl(identifier: string): string {
  return `https://linear.app/issue/${identifier}`;
}
