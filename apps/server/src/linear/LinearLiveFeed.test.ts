import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { issueChangeFromMessage } from "./LinearLiveFeed.ts";

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
