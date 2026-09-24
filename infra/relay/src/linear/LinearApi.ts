import {
  RelayApi,
  RelayAuthInvalidError,
  RelayClientPrincipal,
  RelayEnvironmentPrincipal,
  RelayInternalError,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  LINEAR_OAUTH_CALLBACK_PATH,
  LINEAR_WEBHOOK_PATH,
  LinearIntegration,
  type LinearIntegrationError,
} from "./LinearIntegration.ts";

const currentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

const mapLinearError = (error: LinearIntegrationError) =>
  currentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        error.reason === "not_authorized"
          ? new RelayAuthInvalidError({ code: "auth_invalid", reason: "not_authorized", traceId })
          : new RelayInternalError({
              code: "internal_error",
              reason:
                error.reason === "upstream_failed" ? "upstream_unavailable" : "internal_error",
              traceId,
            }),
      ),
    ),
  );

export const linearApi = HttpApiBuilder.group(
  RelayApi,
  "linear",
  Effect.fnUntraced(function* (handlers) {
    const linear = yield* LinearIntegration;
    return handlers
      .handle(
        "getLinearStatus",
        Effect.fn("relay.api.linear.status")(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* linear.status(userId).pipe(Effect.catch(mapLinearError));
        }),
      )
      .handle(
        "authorizeLinear",
        Effect.fn("relay.api.linear.authorize")(function* ({ payload }) {
          const { userId } = yield* RelayClientPrincipal;
          return yield* linear.authorize(userId, payload).pipe(Effect.catch(mapLinearError));
        }),
      )
      .handle(
        "updateLinearLink",
        Effect.fn("relay.api.linear.update_link")(function* ({ params, payload }) {
          const { userId } = yield* RelayClientPrincipal;
          const ok = yield* linear
            .updateLink(userId, params.organizationId, payload.environmentId)
            .pipe(Effect.catch(mapLinearError));
          return { ok };
        }),
      )
      .handle(
        "unlinkLinear",
        Effect.fn("relay.api.linear.unlink")(function* ({ params }) {
          const { userId } = yield* RelayClientPrincipal;
          const ok = yield* linear
            .unlink(userId, params.organizationId)
            .pipe(Effect.catch(mapLinearError));
          return { ok };
        }),
      );
  }),
);

/** Environments mirroring a delegated thread's progress into its Linear session. */
export const linearServerApi = HttpApiBuilder.group(
  RelayApi,
  "linearServer",
  Effect.fnUntraced(function* (handlers) {
    const linear = yield* LinearIntegration;
    return handlers
      .handle(
        "postLinearActivities",
        Effect.fn("relay.api.linear.post_activities")(function* ({ params, payload }) {
          const principal = yield* RelayEnvironmentPrincipal;
          const traceId = yield* currentTraceId;
          const posted =
            principal.environmentId === params.environmentId &&
            (yield* linear
              .postActivities({
                environmentId: params.environmentId,
                agentSessionId: params.agentSessionId,
                threadId: payload.threadId,
                activities: payload.activities,
              })
              .pipe(Effect.catch(mapLinearError)));
          if (!posted) {
            return yield* new RelayAuthInvalidError({
              code: "auth_invalid",
              reason: "not_authorized",
              traceId,
            });
          }
          return { ok: true };
        }),
      )
      .handle(
        "getLinearUserToken",
        Effect.fn("relay.api.linear.user_token")(function* ({ params }) {
          const principal = yield* RelayEnvironmentPrincipal;
          if (principal.environmentId !== params.environmentId) {
            return yield* new RelayAuthInvalidError({
              code: "auth_invalid",
              reason: "not_authorized",
              traceId: yield* currentTraceId,
            });
          }
          const token = yield* linear
            .userToken({
              environmentId: principal.environmentId,
              environmentPublicKey: principal.environmentPublicKey,
            })
            .pipe(Effect.catch(mapLinearError));
          return { token };
        }),
      );
  }),
);

/**
 * Linear's webhook needs the raw body for its signature, and the OAuth
 * callback answers with a redirect, so both live outside the typed API.
 */
export const linearRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const linear = yield* LinearIntegration;
    yield* router.add("POST", LINEAR_WEBHOOK_PATH, (request) =>
      Effect.gen(function* () {
        const rawBody = yield* request.text;
        const status = yield* linear.receiveWebhook({
          rawBody,
          signature: request.headers["linear-signature"],
        });
        return HttpServerResponse.empty({ status });
      }).pipe(
        Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
        Effect.withSpan("relay.api.linear.webhook"),
      ),
    );
    yield* router.add("GET", LINEAR_OAUTH_CALLBACK_PATH, (request) =>
      Effect.gen(function* () {
        const url = HttpServerRequest.toURL(request);
        const params = url._tag === "Some" ? url.value.searchParams : new URLSearchParams();
        return HttpServerResponse.redirect(yield* linear.oauthCallback(params));
      }).pipe(Effect.withSpan("relay.api.linear.oauth_callback")),
    );
  }),
);
