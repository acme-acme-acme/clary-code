import { describe, expect, it } from "@effect/vitest";

import { normalizeLinearIssueIdentifier, parseLinearIssueReference } from "./linear.ts";

describe("Linear issue references", () => {
  it("normalizes identifiers", () => {
    expect(normalizeLinearIssueIdentifier(" eng-42 ")).toBe("ENG-42");
    expect(normalizeLinearIssueIdentifier("ENG-0")).toBeNull();
    expect(normalizeLinearIssueIdentifier("feature/eng-42")).toBeNull();
  });

  it("reads identifiers and linear.app issue URLs", () => {
    expect(parseLinearIssueReference("ops-7")).toEqual({ identifier: "OPS-7", url: null });
    expect(
      parseLinearIssueReference("https://linear.app/acme/issue/ENG-42/fix-login?foo=1#c"),
    ).toEqual({
      identifier: "ENG-42",
      url: "https://linear.app/acme/issue/ENG-42/fix-login",
    });
    expect(parseLinearIssueReference("https://github.com/acme/app/issues/42")).toBeNull();
    expect(parseLinearIssueReference("not an issue")).toBeNull();
  });
});
