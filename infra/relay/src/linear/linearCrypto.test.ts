import { describe, expect, it } from "@effect/vitest";

import {
  openSecret,
  sealSecret,
  signOAuthState,
  verifyLinearWebhook,
  verifyOAuthState,
} from "./linearCrypto.ts";

async function hexHmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("linearCrypto", () => {
  it("seals tokens so only the same key opens them", async () => {
    const sealed = await sealSecret("key-a", "lin_oauth_token");
    expect(sealed).not.toContain("lin_oauth_token");
    expect(await openSecret("key-a", sealed)).toBe("lin_oauth_token");
    await expect(openSecret("key-b", sealed)).rejects.toThrow();
  });

  it("accepts only unexpired, untampered OAuth state", async () => {
    const state = {
      userId: "user_1",
      kind: "link" as const,
      environmentId: "env-1",
      exp: 1_000,
      nonce: "n",
    };
    const signed = await signOAuthState("secret", state);
    expect(await verifyOAuthState("secret", signed, 999)).toEqual(state);
    expect(await verifyOAuthState("secret", signed, 1_001)).toBeNull();
    expect(await verifyOAuthState("other", signed, 999)).toBeNull();
    const [body, signature] = signed.split(".");
    const forged = btoa(JSON.stringify({ ...state, userId: "user_2" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    expect(await verifyOAuthState("secret", `${forged}.${signature}`, 999)).toBeNull();
    expect(await verifyOAuthState("secret", `${body}`, 999)).toBeNull();
  });

  it("verifies Linear's body signature and rejects stale deliveries", async () => {
    const now = 1_700_000_000_000;
    const rawBody = JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: now });
    const signature = await hexHmac("whsec", rawBody);
    const verify = (overrides: Partial<Parameters<typeof verifyLinearWebhook>[0]>) =>
      verifyLinearWebhook({
        secret: "whsec",
        rawBody,
        signature,
        webhookTimestamp: now,
        nowEpochMillis: now + 5_000,
        ...overrides,
      });
    expect(await verify({})).toBe(true);
    expect(await verify({ signature: signature.toUpperCase() })).toBe(true);
    expect(await verify({ signature: undefined })).toBe(false);
    expect(await verify({ rawBody: `${rawBody} ` })).toBe(false);
    expect(await verify({ secret: "other" })).toBe(false);
    expect(await verify({ nowEpochMillis: now + 120_000 })).toBe(false);
    expect(await verify({ webhookTimestamp: "soon" })).toBe(false);
  });
});
