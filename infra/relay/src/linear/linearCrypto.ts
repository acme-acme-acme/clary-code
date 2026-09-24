/**
 * Small WebCrypto helpers for the Linear integration: sealing OAuth tokens at
 * rest, signing the OAuth `state` round trip, and checking webhook signatures.
 * Plain async functions so they run the same in the Worker and in tests.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function sha256Key(secret: string, usage: "encrypt" | "hmac"): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return usage === "encrypt"
    ? crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"])
    : crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function hmac(key: CryptoKey | string, message: string): Promise<Uint8Array> {
  const cryptoKey =
    typeof key === "string"
      ? await crypto.subtle.importKey(
          "raw",
          encoder.encode(key),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        )
      : key;
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

/** AES-GCM with a fresh IV; the output is `base64url(iv || ciphertext)`. */
export async function sealSecret(keySecret: string, plaintext: string): Promise<string> {
  const key = await sha256Key(keySecret, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)),
  );
  const sealed = new Uint8Array(iv.length + ciphertext.length);
  sealed.set(iv);
  sealed.set(ciphertext, iv.length);
  return toBase64Url(sealed);
}

export async function openSecret(keySecret: string, sealed: string): Promise<string> {
  const key = await sha256Key(keySecret, "encrypt");
  const bytes = fromBase64Url(sealed);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return decoder.decode(plaintext);
}

export interface LinearOAuthState {
  readonly userId: string;
  readonly kind: "install" | "link";
  readonly environmentId: string | null;
  /** Epoch seconds. */
  readonly exp: number;
  readonly nonce: string;
}

export async function signOAuthState(secret: string, state: LinearOAuthState): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(state)));
  const signature = toBase64Url(await hmac(await sha256Key(secret, "hmac"), body));
  return `${body}.${signature}`;
}

/** Null when the state was not issued by this relay or has expired. */
export async function verifyOAuthState(
  secret: string,
  value: string,
  nowEpochSeconds: number,
): Promise<LinearOAuthState | null> {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = toBase64Url(await hmac(await sha256Key(secret, "hmac"), body));
  if (!constantTimeEqual(expected, signature)) return null;
  try {
    const state = JSON.parse(decoder.decode(fromBase64Url(body))) as LinearOAuthState;
    if (typeof state.exp !== "number" || state.exp < nowEpochSeconds) return null;
    if (state.kind !== "install" && state.kind !== "link") return null;
    if (typeof state.userId !== "string" || state.userId.length === 0) return null;
    return state;
  } catch {
    return null;
  }
}

/**
 * Linear signs the raw request body with the webhook secret: hex HMAC-SHA256
 * in `Linear-Signature`. The body's `webhookTimestamp` must also be recent so
 * a captured delivery cannot be replayed later.
 */
export async function verifyLinearWebhook(input: {
  readonly secret: string;
  readonly rawBody: string;
  readonly signature: string | undefined;
  readonly webhookTimestamp: unknown;
  readonly nowEpochMillis: number;
}): Promise<boolean> {
  if (!input.signature) return false;
  const expected = toHex(await hmac(input.secret, input.rawBody));
  if (!constantTimeEqual(expected, input.signature.trim().toLowerCase())) return false;
  return (
    typeof input.webhookTimestamp === "number" &&
    Math.abs(input.nowEpochMillis - input.webhookTimestamp) <= 60_000
  );
}
