import { RelayApi } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** Ask the relay again this long before the sign-in expires. */
const RENEW_BEFORE_MS = 5 * 60 * 1_000;
/** How long a relay answer (including "no sign-in") is trusted. */
const RECHECK_MS = 5 * 60 * 1_000;

export interface LinearCredential {
  /**
   * `user`: the person's Linear sign-in, kept by the relay when they linked
   * their account; it can also read reviews. `apiKey`: the key in settings.
   */
  readonly kind: "user" | "apiKey";
  readonly token: string;
}

/**
 * How this environment reads Linear: the signed-in account of whoever linked
 * it through Otter Connect when the relay holds one, else the API key.
 */
export const makeLinearCredentials = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  let cached: { readonly token: string | null; readonly until: number } | null = null;

  const readSecretString = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map((bytes) =>
          Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
        ),
      );

  const fetchUserToken = Effect.gen(function* () {
    const [url, environmentCredential] = yield* Effect.all([
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    if (!url || !environmentCredential) return null;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const relay = yield* HttpApiClient.make(RelayApi, {
      baseUrl: url,
      transformClient: HttpClient.mapRequest(
        HttpClientRequest.setHeader("authorization", `Bearer ${environmentCredential}`),
      ),
    }).pipe(Effect.provide(FetchHttpClient.layer));
    const response = yield* relay.linearServer.getLinearUserToken({ params: { environmentId } });
    return response.token;
  });

  const userToken: Effect.Effect<string | null> = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (cached === null || cached.until <= now) {
      // An older relay, no link, or a network error all mean: use the API key for now.
      const user = yield* fetchUserToken.pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => null),
      );
      const expiresAt = user?.expiresAt ? Date.parse(user.expiresAt) : Number.NaN;
      cached = {
        token: user?.accessToken ?? null,
        until: Number.isFinite(expiresAt)
          ? Math.min(expiresAt - RENEW_BEFORE_MS, now + RECHECK_MS)
          : now + RECHECK_MS,
      };
    }
    return cached.token;
  });

  const apiKey: Effect.Effect<string | null> = settings.getSettings.pipe(
    Effect.map((value) => value.linear.apiKey || null),
    Effect.orElseSucceed(() => null),
  );

  const current: Effect.Effect<LinearCredential | null> = Effect.gen(function* () {
    const user = yield* userToken;
    if (user !== null) return { kind: "user", token: user };
    const key = yield* apiKey;
    return key === null ? null : { kind: "apiKey", token: key };
  });

  return {
    current,
    /** Forget the cached sign-in, e.g. after Linear rejected it. */
    invalidate: Effect.sync(() => {
      cached = null;
    }),
  };
});
