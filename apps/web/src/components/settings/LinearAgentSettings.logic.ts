import type { Discovery } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";

export interface LinearMachineOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Whether the machine is reachable, plus what tells apart machines that share a name. */
  readonly detail: string;
  readonly online: boolean;
}

const AVAILABILITY_LABELS: Record<Discovery.RelayEnvironmentAvailability, string> = {
  online: "Online",
  offline: "Offline",
  checking: "Checking…",
  error: "Unreachable",
};

const linkedDate = (linkedAt: string) => {
  const date = new Date(linkedAt);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

/**
 * The machines delegated Linear issues can run on, online first, then the most
 * recently linked. The relay keeps a record per link, so relinking a machine
 * can leave stale entries with the same name; those get their link date and id.
 */
export function linearMachineOptions(
  discovered: Iterable<Pick<Discovery.RelayDiscoveredEnvironment, "environment" | "availability">>,
): ReadonlyArray<LinearMachineOption> {
  const entries = [...discovered];
  const labelCounts = new Map<string, number>();
  for (const { environment } of entries) {
    labelCounts.set(environment.label, (labelCounts.get(environment.label) ?? 0) + 1);
  }
  return entries
    .toSorted(
      (left, right) =>
        Number(right.availability === "online") - Number(left.availability === "online") ||
        right.environment.linkedAt.localeCompare(left.environment.linkedAt),
    )
    .map(({ environment, availability }) => {
      const parts = [AVAILABILITY_LABELS[availability]];
      if ((labelCounts.get(environment.label) ?? 0) > 1) {
        const date = linkedDate(environment.linkedAt);
        if (date) parts.push(`linked ${date}`);
        parts.push(environment.environmentId.slice(0, 8));
      }
      return {
        environmentId: environment.environmentId,
        label: environment.label,
        detail: parts.join(" · "),
        online: availability === "online",
      };
    });
}
