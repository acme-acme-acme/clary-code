import type { ThreadLinearIssueLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveLinkLinearIssueInput, resolveThreadLinearIssueBadge } from "./linearIssues.logic";

function issue(
  identifier: string,
  snapshot: Partial<NonNullable<ThreadLinearIssueLink["snapshot"]>> | null = null,
): ThreadLinearIssueLink {
  return {
    identifier,
    issueId: null,
    url: `https://linear.app/acme/issue/${identifier}`,
    source: "manual",
    linkedAt: "2026-09-24T10:00:00.000Z",
    snapshot:
      snapshot === null
        ? null
        : {
            identifier,
            title: "Fix login",
            state: { name: "In Progress", type: "started", color: "#f2c94c" },
            assignee: null,
            updatedAt: null,
            syncedAt: "2026-09-24T10:01:00.000Z",
            ...snapshot,
          },
  };
}

describe("resolveThreadLinearIssueBadge", () => {
  it("is absent without linked issues", () => {
    expect(resolveThreadLinearIssueBadge(undefined)).toBeNull();
    expect(resolveThreadLinearIssueBadge([])).toBeNull();
  });

  it("shows an unsynced issue by identifier alone", () => {
    expect(resolveThreadLinearIssueBadge([issue("ENG-1")])).toMatchObject({
      text: "ENG-1",
      label: "Linear issue ENG-1",
    });
  });

  it("leads with the first issue and counts the rest", () => {
    const badge = resolveThreadLinearIssueBadge([
      issue("ENG-1", {}),
      issue("ENG-2"),
      issue("OPS-3"),
    ]);
    expect(badge?.lead.identifier).toBe("ENG-1");
    expect(badge?.text).toBe("ENG-1 +2");
    expect(badge?.label).toBe("Linear issue ENG-1: Fix login, In Progress, and 2 more");
  });
});

describe("resolveLinkLinearIssueInput", () => {
  it("builds a workspace-less URL for a bare identifier", () => {
    expect(resolveLinkLinearIssueInput(" eng-42 ")).toEqual({
      identifier: "ENG-42",
      url: "https://linear.app/issue/ENG-42",
    });
  });

  it("keeps a pasted issue URL without its query", () => {
    expect(
      resolveLinkLinearIssueInput("https://linear.app/acme/issue/ENG-42/fix-login?foo=1"),
    ).toEqual({ identifier: "ENG-42", url: "https://linear.app/acme/issue/ENG-42/fix-login" });
  });

  it("rejects anything else", () => {
    expect(resolveLinkLinearIssueInput("#42")).toBeNull();
    expect(resolveLinkLinearIssueInput("https://example.com/issue/ENG-42")).toBeNull();
  });
});
