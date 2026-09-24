import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  issueChangeFromMessage,
  linearFeedCredential,
  reconnectDelayMs,
  rejectsCredential,
} from "./LinearLiveFeed.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("issueChangeFromMessage", () => {
  it("reads the issue from issue, comment, and history events", () => {
    expect(
      issueChangeFromMessage(
        encode({
          type: "next",
          id: "1",
          payload: { data: { issueUpdated: { id: "uuid-1", identifier: "ENG-1" } } },
        }),
      ),
    ).toEqual({ issueId: "uuid-1", identifier: "ENG-1" });
    expect(
      issueChangeFromMessage(
        encode({
          type: "next",
          id: "2",
          payload: { data: { commentCreated: { issue: { id: "uuid-2", identifier: "ENG-2" } } } },
        }),
      ),
    ).toEqual({ issueId: "uuid-2", identifier: "ENG-2" });
  });

  it("ignores protocol messages and malformed input", () => {
    for (const raw of [encode({ type: "connection_ack" }), encode({ type: "ping" }), "not json"]) {
      expect(issueChangeFromMessage(raw)).toBeNull();
    }
  });
});

describe("linearFeedCredential", () => {
  it("prefers the sign-in and falls back to the API key once Linear refuses it", () => {
    const both = { user: "lin_oauth_a", apiKey: "lin_api_b" };
    expect(linearFeedCredential(both, null)).toEqual({ token: "lin_oauth_a", kind: "sign-in" });
    expect(linearFeedCredential(both, "lin_oauth_a")).toEqual({
      token: "lin_api_b",
      kind: "API key",
    });
    // A refreshed sign-in gets another chance.
    expect(linearFeedCredential({ ...both, user: "lin_oauth_c" }, "lin_oauth_a")?.kind).toBe(
      "sign-in",
    );
    expect(linearFeedCredential({ user: "lin_oauth_a", apiKey: null }, "lin_oauth_a")).toBeNull();
  });

  it("treats only auth close codes as a refused credential", () => {
    expect([4002, 4003, 4401, 4403].every(rejectsCredential)).toBe(true);
    expect([1000, 1006, 4500].some(rejectsCredential)).toBe(false);
  });

  it("backs off reconnects while Linear keeps refusing, up to five minutes", () => {
    expect([0, 1, 2, 3, 10].map(reconnectDelayMs)).toEqual([
      10_000, 10_000, 20_000, 40_000, 300_000,
    ]);
  });
});
