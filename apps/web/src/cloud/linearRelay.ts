import type { EnvironmentId } from "@t3tools/contracts";
import {
  RelayLinearAuthorizeResponse,
  RelayLinearStatusResponse,
  type RelayLinearAuthorizeKind,
} from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";

import { resolveCloudPublicConfig } from "./publicConfig";

/**
 * The relay's Linear account endpoints. They are account-level (Clerk
 * bearer), not environment-level, so they sit beside T3 Connect rather than
 * going through an environment connection.
 */
async function relayFetch(
  clerkToken: string,
  path: string,
  init: { readonly method: "GET" | "POST" | "DELETE"; readonly body?: unknown },
): Promise<unknown> {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) throw new Error("Otter Connect is not configured for this build.");
  const response = await fetch(new URL(path, relayUrl), {
    method: init.method,
    headers: {
      authorization: `Bearer ${clerkToken}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    throw new Error(`Linear request failed (${response.status}).`);
  }
  return response.json();
}

export async function fetchLinearStatus(clerkToken: string) {
  return Schema.decodeUnknownSync(RelayLinearStatusResponse)(
    await relayFetch(clerkToken, "/v1/client/linear", { method: "GET" }),
  );
}

/** Returns the Linear consent URL to open; the relay's callback returns to Connections settings. */
export async function startLinearAuthorization(
  clerkToken: string,
  kind: RelayLinearAuthorizeKind,
  environmentId?: EnvironmentId,
) {
  const response = Schema.decodeUnknownSync(RelayLinearAuthorizeResponse)(
    await relayFetch(clerkToken, "/v1/client/linear/authorize", {
      method: "POST",
      body: { kind, ...(environmentId ? { environmentId } : {}) },
    }),
  );
  return response.url;
}

export async function updateLinearLinkEnvironment(
  clerkToken: string,
  organizationId: string,
  environmentId: EnvironmentId,
) {
  await relayFetch(clerkToken, `/v1/client/linear/links/${encodeURIComponent(organizationId)}`, {
    method: "POST",
    body: { environmentId },
  });
}

export async function unlinkLinearAccount(clerkToken: string, organizationId: string) {
  await relayFetch(clerkToken, `/v1/client/linear/links/${encodeURIComponent(organizationId)}`, {
    method: "DELETE",
  });
}
