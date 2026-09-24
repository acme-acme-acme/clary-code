import type { ThreadLinearIssueLink } from "@t3tools/contracts";

export interface ThreadLinearIssueBadge {
  /** Compact row label, e.g. "ENG-123" or "ENG-123 +2". */
  readonly label: string;
  /** Linear workflow state color of the lead issue; null until synced. */
  readonly stateColor: string | null;
  readonly accessibilityLabel: string;
}

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;

/** Linear sends hex colors; anything else is dropped rather than handed to native styles. */
export function linearIssueStateColor(link: ThreadLinearIssueLink): string | null {
  const color = link.snapshot?.state.color.trim();
  return color !== undefined && HEX_COLOR_PATTERN.test(color) ? color : null;
}

/** The issue that started a delegated thread leads; otherwise link order wins. */
function leadLinearIssue(links: ReadonlyArray<ThreadLinearIssueLink>) {
  return links.find((link) => link.source === "delegated") ?? links[0];
}

/** Thread list badge; null when the thread has no linked issues. */
export function presentThreadLinearIssues(
  links: ReadonlyArray<ThreadLinearIssueLink> | undefined,
): ThreadLinearIssueBadge | null {
  if (links === undefined) return null;
  const lead = leadLinearIssue(links);
  if (lead === undefined) return null;
  const others = links.length - 1;
  const state = lead.snapshot?.state.name ?? "status pending";
  return {
    label: others > 0 ? `${lead.identifier} +${others}` : lead.identifier,
    stateColor: linearIssueStateColor(lead),
    accessibilityLabel:
      others > 0
        ? `Linear issue ${lead.identifier}, ${state}, and ${others} more`
        : `Linear issue ${lead.identifier}, ${state}`,
  };
}

/** "In Progress · Alice", falling back to a pending label before the first sync. */
export function linearIssueDetail(link: ThreadLinearIssueLink): string {
  const snapshot = link.snapshot;
  if (snapshot === null) return "Status pending";
  return snapshot.assignee === null
    ? `${snapshot.state.name} · Unassigned`
    : `${snapshot.state.name} · ${snapshot.assignee}`;
}
