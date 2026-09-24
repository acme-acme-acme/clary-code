import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeLinearApi, makeSignedUploadCache, reviewUrlFromMcpResponse } from "./LinearApi.ts";
import { issueOfDetail } from "./LinearIssueSyncReactor.ts";

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

describe("LinearApi.readIssueDetail", () => {
  const person = (displayName: string) => ({ displayName, avatarUrl: null });
  const history = (fields: Record<string, unknown>) => ({
    actor: person("ada"),
    botActor: null,
    fromState: null,
    toState: null,
    fromAssignee: null,
    toAssignee: null,
    addedLabels: null,
    removedLabels: null,
    fromPriority: null,
    toPriority: null,
    fromTitle: null,
    toTitle: null,
    attachment: null,
    ...fields,
  });
  const detailNode = {
    ...issueNode("ENG-7", "started"),
    description: null,
    priority: 2,
    priorityLabel: "High",
    createdAt: "2026-09-01T10:00:00.000Z",
    branchName: "eng-7-fix-login",
    assignee: person("ada"),
    creator: person("karl"),
    team: {
      key: "ENG",
      name: "Engineering",
      states: { nodes: [{ position: 2 }, { position: 1 }, { position: 3 }] },
    },
    project: null,
    labels: { nodes: [{ name: "Bug", color: "#ff0000" }] },
    attachments: { nodes: [] },
    comments: {
      nodes: [
        {
          id: "c1",
          body: "This comment thread is synced to Slack.",
          createdAt: "2026-09-03T10:00:00.000Z",
          parent: null,
          user: person("karl"),
          botActor: null,
          externalUser: null,
          externalThread: { name: "Slack", displayName: "#design", url: "https://slack/1" },
          syncedWith: [{ service: "slack", metadata: { isFromSlack: false } }],
        },
        {
          id: "c2",
          body: "Looks good",
          createdAt: "2026-09-03T11:00:00.000Z",
          parent: { id: "c1" },
          user: null,
          botActor: { name: "Slack" },
          externalUser: { name: "Elad", avatarUrl: null },
          externalThread: null,
          syncedWith: [{ service: "slack", metadata: { isFromSlack: true } }],
        },
      ],
    },
    history: {
      nodes: [
        history({
          id: "h1",
          createdAt: "2026-09-02T10:00:00.000Z",
          fromState: { name: "Todo", color: "#e2e2e2", type: "unstarted", position: 0 },
          toState: { name: "In Progress", color: "#f2994a", type: "started", position: 2 },
        }),
        history({
          id: "h2",
          createdAt: "2026-09-04T10:00:00.000Z",
          fromPriority: 3,
          toPriority: 2,
        }),
        // A description edit: nothing the page can show.
        history({ id: "h3", createdAt: "2026-09-05T10:00:00.000Z" }),
      ],
    },
  };

  it.effect("merges comments and recorded changes, oldest first", () =>
    Effect.gen(function* () {
      const test = fixture(() => ({ data: { issue: detailNode } }));
      const detail = yield* (yield* test.api).readIssueDetail("lin_api_key", "ENG-7");
      expect(detail?.description).toBe("");
      expect(detail?.activity.map((entry) => [entry.id, entry.kind])).toEqual([
        ["created:uuid-ENG-7", "created"],
        ["h1", "state"],
        ["c1", "comment"],
        ["c2", "comment"],
        ["h2", "priority"],
      ]);
      expect(detail?.activity[0]?.actor?.name).toBe("karl");
      // The middle of three started states: its icon's pie is half full.
      expect(detail?.activity[1]).toMatchObject({ to: { type: "started", progress: 0.5 } });
      expect(detail?.activity[2]).toMatchObject({
        via: null,
        syncedThread: { source: "Slack", displayName: "#design" },
      });
      expect(detail?.activity[3]).toMatchObject({ actor: { name: "Elad" }, via: "Slack" });
      expect(detail?.activity[4]).toMatchObject({ from: "Medium", to: "High" });
    }),
  );

  it.effect("reads the same sidebar status from the issue page as from a sync", () =>
    Effect.gen(function* () {
      const test = fixture((query) =>
        query.includes("i0:") ? { data: { i0: detailNode } } : { data: { issue: detailNode } },
      );
      const api = yield* test.api;
      const synced = (yield* api.readIssues("lin_api_key", ["ENG-7"])).get("ENG-7");
      const detail = yield* api.readIssueDetail("lin_api_key", "ENG-7");
      expect(detail && issueOfDetail(detail)).toEqual(synced);
    }),
  );

  it.effect("reads a missing issue as null", () =>
    Effect.gen(function* () {
      const test = fixture(() => ({ errors: [{ message: "Entity not found: Issue" }] }));
      expect(yield* (yield* test.api).readIssueDetail("lin_api_key", "ENG-404")).toBeNull();
    }),
  );
});

describe("makeSignedUploadCache", () => {
  const upload = (signature: string) =>
    `![shot](https://uploads.linear.app/org/file-1?signature=${signature})`;

  it("keeps the first signed URL for a file until it nears expiry", () => {
    const cache = makeSignedUploadCache();
    const hour = 60 * 60 * 1_000;
    expect(cache.stabilize(upload("first"), 0)).toBe(upload("first"));
    // A re-read signs the same file again; the page keeps its URL, so the image doesn't reload.
    expect(cache.stabilize(upload("second"), hour)).toBe(upload("first"));
    // Within the last hour of the 12-hour signature, the new one takes over.
    expect(cache.stabilize(upload("third"), 11.5 * hour)).toBe(upload("third"));
  });
});

describe("reviewUrlFromMcpResponse", () => {
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  const answer = (text: string, isError = false) =>
    `event: message\ndata: ${encode({ jsonrpc: "2.0", id: 1, result: { isError, content: [{ type: "text", text }] } })}\n`;

  it("reads Linear's review page from a get_diff answer", () => {
    expect(
      reviewUrlFromMcpResponse(
        answer(encode({ appUrl: "https://linear.app/acme/review/fix-login-d003c35c482c" })),
      ),
    ).toBe("https://linear.app/acme/review/fix-login-d003c35c482c");
  });

  it("reads a missing review, an error, or anything unexpected as none", () => {
    expect(reviewUrlFromMcpResponse(answer("Error: Diff not found", true))).toBeNull();
    expect(reviewUrlFromMcpResponse(answer(encode({ appUrl: "https://evil.example" })))).toBeNull();
    expect(reviewUrlFromMcpResponse("<html>")).toBeNull();
  });
});
