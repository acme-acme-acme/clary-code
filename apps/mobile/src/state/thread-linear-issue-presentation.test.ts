import type { ThreadLinearIssueLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  linearIssueDetail,
  linearIssueStateColor,
  presentThreadLinearIssues,
} from "./thread-linear-issue-presentation";

function issue(
  identifier: string,
  overrides: Partial<ThreadLinearIssueLink> = {},
): ThreadLinearIssueLink {
  return {
    identifier,
    issueId: `id-${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
    source: "manual",
    linkedAt: "2026-09-24T00:00:00.000Z",
    snapshot: {
      identifier,
      title: `Fix ${identifier}`,
      state: { name: "In Progress", type: "started", color: "#f2c94c" },
      assignee: "Alice",
      updatedAt: null,
      syncedAt: "2026-09-24T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("presentThreadLinearIssues", () => {
  it("returns null without linked issues", () => {
    expect(presentThreadLinearIssues(undefined)).toBeNull();
    expect(presentThreadLinearIssues([])).toBeNull();
  });

  it("shows the lone identifier with its state color", () => {
    expect(presentThreadLinearIssues([issue("ENG-1")])).toEqual({
      label: "ENG-1",
      stateColor: "#f2c94c",
      accessibilityLabel: "Linear issue ENG-1, In Progress",
    });
  });

  it("leads with the delegated issue and counts the rest", () => {
    expect(
      presentThreadLinearIssues([
        issue("ENG-1"),
        issue("ENG-2", { source: "delegated", snapshot: null }),
        issue("ENG-3"),
      ]),
    ).toEqual({
      label: "ENG-2 +2",
      stateColor: null,
      accessibilityLabel: "Linear issue ENG-2, status pending, and 2 more",
    });
  });
});

describe("linearIssueStateColor", () => {
  it("drops non-hex colors", () => {
    const link = issue("ENG-1");
    expect(
      linearIssueStateColor({
        ...link,
        snapshot: { ...link.snapshot!, state: { ...link.snapshot!.state, color: "red" } },
      }),
    ).toBeNull();
  });
});

describe("linearIssueDetail", () => {
  it("describes state and assignee, or a pending status before sync", () => {
    expect(linearIssueDetail(issue("ENG-1"))).toBe("In Progress · Alice");
    const link = issue("ENG-1");
    expect(linearIssueDetail({ ...link, snapshot: { ...link.snapshot!, assignee: null } })).toBe(
      "In Progress · Unassigned",
    );
    expect(linearIssueDetail(issue("ENG-1", { snapshot: null }))).toBe("Status pending");
  });
});
