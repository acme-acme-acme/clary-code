import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import type { RelayLinearAgentPromptOutcome } from "@t3tools/contracts/relay";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import {
  relayLinearAgentSessions,
  relayLinearInstallations,
  relayLinearUserTokens,
} from "../persistence/schema.ts";
import { LinearEventQueueSender, LinearIntegration, layer } from "./LinearIntegration.ts";
import { sealSecret } from "./linearCrypto.ts";

const WEBHOOK_SECRET = "whsec";
const SEALING_KEY = "sealing-key";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const settings = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: null,
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make("unused"),
  cloudMintPublicKey: "unused",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
  linear: {
    clientId: "client-id",
    clientSecret: Redacted.make("client-secret"),
    webhookSecret: Redacted.make(WEBHOOK_SECRET),
    tokenSealingKey: Redacted.make(SEALING_KEY),
    stateSigningKey: Redacted.make("state-key"),
    hostedAppUrl: "https://app.example.test",
  },
});

async function signWebhook(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * An installed workspace whose app token Linear answers with `appTokenStatus`,
 * and one delegated session running thread `thread-1` on `env-1`.
 */
const makeHarness = (
  appTokenStatus: number,
  promptOutcome: RelayLinearAgentPromptOutcome = "delivered",
) =>
  Effect.gen(function* () {
    const installation = {
      organizationId: "org-1",
      organizationName: "Acme",
      appUserId: "app-user",
      accessTokenSealed: yield* Effect.promise(() => sealSecret(SEALING_KEY, "app-token")),
      refreshTokenSealed: null,
      accessTokenExpiresAt: null,
      installedByUserId: "user_1",
      revokedAt: null,
    };
    const userToken = {
      userId: "user_1",
      organizationId: "org-1",
      organizationName: "Acme",
      linearUserName: "Ada",
      updatedAt: "2026-09-24T10:00:00.000Z",
      accessTokenSealed: yield* Effect.promise(() => sealSecret(SEALING_KEY, "user-token")),
      refreshTokenSealed: null,
      accessTokenExpiresAt: null,
    };
    const session = {
      agentSessionId: "session-1",
      organizationId: "org-1",
      userId: "user_1",
      environmentId: "env-1",
      threadId: "thread-1",
    };
    const revocations: Array<unknown> = [];
    const probedTokens: Array<string | undefined> = [];
    const linearRequests: Array<string> = [];
    const prompts: Array<unknown> = [];
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows =
              table === relayLinearInstallations
                ? [installation]
                : table === relayLinearAgentSessions
                  ? [session]
                  : table === relayLinearUserTokens
                    ? [userToken]
                    : [];
            return {
              limit: () => Effect.succeed(rows),
              orderBy: () => ({ limit: () => Effect.succeed(rows) }),
            };
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (values: unknown) => ({
          where: () =>
            Effect.sync(() => {
              expect(table).toBe(relayLinearInstallations);
              revocations.push(values);
            }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        probedTokens.push(request.headers.authorization);
        linearRequests.push(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            encodeJson({ data: { viewer: { id: "app-user" }, agentActivityCreate: {} } }),
            { status: appTokenStatus },
          ),
        );
      }),
    );
    const integration = yield* LinearIntegration.pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              RelayConfiguration.layer(settings),
              Layer.succeed(RelayDb.RelayDb, fakeDb),
              Layer.mock(EnvironmentLinks.EnvironmentLinks)({
                listDeliveryUsersForEnvironment: ({ environmentId }) =>
                  Effect.succeed(
                    environmentId === "env-1"
                      ? [
                          {
                            userId: "user_1",
                            notificationsEnabled: true,
                            liveActivitiesEnabled: true,
                          },
                        ]
                      : [],
                  ),
              }),
              Layer.mock(EnvironmentConnector.EnvironmentConnector)({
                linearPrompt: (input) =>
                  Effect.sync(() => {
                    prompts.push(input);
                    return promptOutcome;
                  }),
              }),
              Layer.mock(LinearEventQueueSender)({}),
              Layer.succeed(HttpClient.HttpClient, http),
              NodeCryptoLayer.layer,
            ),
          ),
        ),
      ),
    );
    const deliverRevoked = Effect.gen(function* () {
      const rawBody = encodeJson({
        type: "OAuthApp",
        action: "revoked",
        organizationId: "org-1",
        oauthClientId: "client-id",
        webhookTimestamp: 0,
      });
      const signature = yield* Effect.promise(() => signWebhook(rawBody));
      return yield* integration.receiveWebhook({ rawBody, signature });
    });
    const deliverPrompted = (agentActivity: unknown) =>
      integration.processEvent({
        action: "prompted",
        organizationId: "org-1",
        agentSession: { id: "session-1" },
        agentActivity,
      });
    return {
      integration,
      deliverRevoked,
      deliverPrompted,
      revocations,
      probedTokens,
      linearRequests,
      prompts,
    };
  });

describe("LinearIntegration OAuthApp revoked", () => {
  it.effect("keeps the installation when the workspace app token still works", () =>
    Effect.gen(function* () {
      // Linear sends `OAuthApp revoked` when one user's authorization ends, e.g. after linking.
      const { deliverRevoked, revocations, probedTokens } = yield* makeHarness(200);
      expect(yield* deliverRevoked).toBe(200);
      expect(probedTokens).toEqual(["Bearer app-token"]);
      expect(revocations).toEqual([]);
    }),
  );

  it.effect("marks the installation revoked once Linear rejects the app token", () =>
    Effect.gen(function* () {
      const { deliverRevoked, revocations } = yield* makeHarness(401);
      expect(yield* deliverRevoked).toBe(200);
      expect(revocations).toHaveLength(1);
      expect(revocations[0]).toMatchObject({ revokedAt: expect.any(String) });
    }),
  );

  it.effect("keeps the installation when Linear can't be asked", () =>
    Effect.gen(function* () {
      const { deliverRevoked, revocations } = yield* makeHarness(503);
      expect(yield* deliverRevoked).toBe(200);
      expect(revocations).toEqual([]);
    }),
  );
});

describe("LinearIntegration prompts and mirrored activities", () => {
  it.effect("hands a reply to the session's machine and a stop as a stop", () =>
    Effect.gen(function* () {
      const { deliverPrompted, prompts, linearRequests } = yield* makeHarness(200);
      yield* deliverPrompted({ id: "act-1", content: { body: " Use pg " } });
      yield* deliverPrompted({ id: "act-2", signal: "stop", content: { body: "" } });
      expect(prompts).toEqual([
        {
          userId: "user_1",
          environmentId: "env-1",
          agentSessionId: "session-1",
          activityId: "act-1",
          kind: "message",
          body: "Use pg",
        },
        {
          userId: "user_1",
          environmentId: "env-1",
          agentSessionId: "session-1",
          activityId: "act-2",
          kind: "stop",
          body: "",
        },
      ]);
      expect(linearRequests.some((body) => body.includes("Stopped the thread"))).toBe(true);
    }),
  );

  it.effect("posts activities only for the environment and thread running the session", () =>
    Effect.gen(function* () {
      const { integration, linearRequests } = yield* makeHarness(200);
      const activities = [{ type: "response" as const, body: "Fixed it." }];
      const foreign = yield* integration.postActivities({
        environmentId: "env-2",
        agentSessionId: "session-1",
        threadId: "thread-1",
        activities,
      });
      expect(foreign).toBe(false);
      expect(linearRequests).toEqual([]);

      const own = yield* integration.postActivities({
        environmentId: "env-1",
        agentSessionId: "session-1",
        threadId: "thread-1",
        activities,
      });
      expect(own).toBe(true);
      expect(linearRequests.some((body) => body.includes("Fixed it."))).toBe(true);
    }),
  );
});

describe("LinearIntegration user sign-in", () => {
  it.effect("gives an environment its owner's Linear sign-in, and nothing to others", () =>
    Effect.gen(function* () {
      const { integration } = yield* makeHarness(200);
      const own = yield* integration.userToken({
        environmentId: "env-1",
        environmentPublicKey: "key-1",
      });
      expect(own).toMatchObject({ accessToken: "user-token", linearUserName: "Ada" });
      const other = yield* integration.userToken({
        environmentId: "env-2",
        environmentPublicKey: "key-2",
      });
      expect(other).toBeNull();
    }),
  );
});
