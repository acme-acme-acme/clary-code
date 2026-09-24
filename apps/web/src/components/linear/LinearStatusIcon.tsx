import type { LinearIssueStateType } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
const MUTED = "var(--color-muted-foreground)";

/**
 * Linear's workflow-state glyphs, drawn from the state's type and color:
 * dashed ring for backlog, empty ring for unstarted, a ring with a pie filled
 * by `progress` for started, and filled discs for triage, done, and canceled.
 */
export function LinearStatusIcon({
  state,
  className,
}: {
  readonly state:
    | {
        readonly name?: string | undefined;
        readonly type?: LinearIssueStateType | undefined;
        readonly color: string;
        readonly progress?: number | undefined;
      }
    | null
    | undefined;
  readonly className?: string | undefined;
}) {
  const color = state && HEX_COLOR_PATTERN.test(state.color) ? state.color : MUTED;
  const type = state?.type ?? "backlog";
  const common = {
    viewBox: "0 0 14 14",
    className: cn("size-3.5 shrink-0", className),
    "aria-hidden": true,
    fill: "none",
  } as const;
  switch (type) {
    case "backlog":
    case "unknown":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6" stroke={color} strokeWidth="1.5" strokeDasharray="1.4 1.74" />
        </svg>
      );
    case "unstarted":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6" stroke={color} strokeWidth="1.5" />
        </svg>
      );
    case "started": {
      const radius = 2;
      const circumference = 2 * Math.PI * radius;
      const progress = Math.min(Math.max(state?.progress ?? 0.5, 0.05), 1);
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6" stroke={color} strokeWidth="1.5" />
          <circle
            cx="7"
            cy="7"
            r={radius}
            stroke={color}
            strokeWidth={radius * 2}
            strokeDasharray={`${progress * circumference} ${circumference}`}
            transform="rotate(-90 7 7)"
          />
        </svg>
      );
    }
    case "triage":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="7" fill={color} />
          <path
            d="M3.6 7h6.8M5.4 5.2 3.6 7l1.8 1.8M8.6 5.2 10.4 7 8.6 8.8"
            stroke="white"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "completed":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="7" fill={color} />
          <path
            d="M4.2 7.2 6.1 9.1 9.9 5.1"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "canceled":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="7" fill={color} />
          <path
            d={
              /duplicate/iu.test(state?.name ?? "")
                ? "M9.3 4.7 4.7 9.3"
                : "M4.9 4.9l4.2 4.2M9.1 4.9 4.9 9.1"
            }
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

/** Linear's priority glyphs: dashes for none, a filled square for urgent, signal bars otherwise. */
export function LinearPriorityIcon({
  priority,
  className,
}: {
  readonly priority: number;
  readonly className?: string;
}) {
  const common = {
    viewBox: "0 0 14 14",
    className: cn("size-3.5 shrink-0", className),
    "aria-hidden": true,
  } as const;
  if (priority === 1) {
    return (
      <svg {...common}>
        <rect width="14" height="14" rx="3" fill="#f2994a" />
        <path d="M7 3.5v4.2" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="7" cy="10.2" r="1" fill="white" />
      </svg>
    );
  }
  if (priority < 1 || priority > 4) {
    return (
      <svg
        {...common}
        fill="currentColor"
        className={cn(common.className, "text-muted-foreground")}
      >
        <rect x="1.5" y="6.25" width="3" height="1.5" rx="0.5" />
        <rect x="5.5" y="6.25" width="3" height="1.5" rx="0.5" />
        <rect x="9.5" y="6.25" width="3" height="1.5" rx="0.5" />
      </svg>
    );
  }
  // High fills all three bars, medium two, low one.
  const filled = 5 - priority;
  return (
    <svg {...common} fill="currentColor">
      {[0, 1, 2].map((bar) => (
        <rect
          key={bar}
          x={1.5 + bar * 4}
          y={9 - bar * 3}
          width="3"
          height={4 + bar * 3}
          rx="1"
          opacity={bar < filled ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}
