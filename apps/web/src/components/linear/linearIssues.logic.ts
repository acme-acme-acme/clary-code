import {
  linearIssueUrl,
  parseLinearIssueReference,
  type ThreadLinearIssueLink,
} from "@t3tools/contracts";

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

/** Linear's workflow-state color, or null before the first sync or for a malformed value. */
export function linearIssueStateColor(issue: ThreadLinearIssueLink): string | null {
  const color = issue.snapshot?.state.color;
  return color !== undefined && HEX_COLOR_PATTERN.test(color) ? color : null;
}

export interface ThreadLinearIssueBadge {
  /** The issue whose identifier and state the badge shows. */
  readonly lead: ThreadLinearIssueLink;
  readonly text: string;
  readonly label: string;
}

/** The sidebar badge: the first linked issue, with a count of the rest. */
export function resolveThreadLinearIssueBadge(
  issues: ReadonlyArray<ThreadLinearIssueLink> | undefined,
): ThreadLinearIssueBadge | null {
  const lead = issues?.[0];
  if (issues === undefined || lead === undefined) return null;
  const others = issues.length - 1;
  const snapshot = lead.snapshot;
  const detail = snapshot === null ? "" : `: ${snapshot.title}, ${snapshot.state.name}`;
  return {
    lead,
    text: others > 0 ? `${lead.identifier} +${others}` : lead.identifier,
    label: `Linear issue ${lead.identifier}${detail}${others > 0 ? `, and ${others} more` : ""}`,
  };
}

/** What the link dialog dispatches for "ENG-123" or a linear.app issue URL, or null. */
export function resolveLinkLinearIssueInput(
  text: string,
): { readonly identifier: string; readonly url: string } | null {
  const parsed = parseLinearIssueReference(text);
  if (parsed === null) return null;
  return { identifier: parsed.identifier, url: parsed.url ?? linearIssueUrl(parsed.identifier) };
}
