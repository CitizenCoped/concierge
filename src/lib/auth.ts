// Edge-safe auth helpers (middleware runs on the edge runtime — Web Crypto only).

export const AUTH_COOKIE = "angel_auth";
const SESSION_INPUT = "angel-concierge-session-v1";

/** The auth cookie value: HMAC-SHA256(session-constant) keyed by APP_PASSPHRASE. */
export async function expectedToken(): Promise<string> {
  const pass = process.env.APP_PASSPHRASE ?? "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pass),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(SESSION_INPUT)
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time string comparison (edge-safe — no node:crypto). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
