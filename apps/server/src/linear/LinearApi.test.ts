import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeLinearApi } from "./LinearApi.ts";

function issueNode(identifier: string, stateType: string) {
  return {
    id: `uuid-${identifier}`,
    identifier,
    title: `Title ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
    updatedAt: "2026-09-24T10:00:00.000Z",
    state: { name: "State", type: stateType, color: "#123456" },
    assignee: null,
  };
}

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ query: Schema.String })),
);

function fixture(respond: (query: string) => unknown) {
  const requests: Array<{ authorization: string | undefined; query: string }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array"
          ? decodeBody(new TextDecoder().decode(request.body.body))
          : { query: "" };
      requests.push({ authorization: request.headers.authorization, query: body.query });
      return HttpClientResponse.fromWeb(request, Response.json(respond(body.query)));
    }),
  );
  return { requests, api: makeLinearApi.pipe(Effect.provideService(HttpClient.HttpClient, http)) };
}

describe("LinearApi.readIssues", () => {
  it.effect("reads issues in aliased batches and skips ones Linear did not return", () =>
    Effect.gen(function* () {
      const references = Array.from({ length: 51 }, (_, index) => `ENG-${index + 1}`);
      const test = fixture((query) => {
        const data: Record<string, unknown> = {};
        for (const match of query.matchAll(/(i\d+): issue\(id: "([^"]+)"\)/gu)) {
          // ENG-2 was deleted; Linear answers its alias with null.
          data[match[1]!] = match[2] === "ENG-2" ? null : issueNode(match[2]!, "started");
        }
        return { data };
      });
      const api = yield* test.api;
      const issues = yield* api.readIssues("lin_api_key", references);
      expect(test.requests).toHaveLength(2);
      expect(test.requests[0]?.authorization).toBe("lin_api_key");
      expect(issues.size).toBe(50);
      expect(issues.has("ENG-2")).toBe(false);
      expect(issues.get("ENG-51")?.state.type).toBe("started");
    }),
  );

  it.effect("maps unknown state types and fails when Linear returns no data", () =>
    Effect.gen(function* () {
      const ok = fixture(() => ({ data: { i0: issueNode("ENG-1", "paused") } }));
      const issues = yield* (yield* ok.api).readIssues("lin_oauth_token", ["ENG-1"]);
      expect(issues.get("ENG-1")?.state.type).toBe("unknown");
      expect(ok.requests[0]?.authorization).toBe("Bearer lin_oauth_token");

      const denied = fixture(() => ({ errors: [{ message: "Authentication required" }] }));
      const error = yield* (yield* denied.api).readIssues("bad", ["ENG-1"]).pipe(Effect.flip);
      expect(error.detail).toBe("Authentication required");
    }),
  );
});
