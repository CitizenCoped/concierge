import { createHmac, timingSafeEqual } from "node:crypto";

/** `sha256=<hex>` HMAC-SHA256 over `{timestamp}.{raw_body}`. */
export function computeSignature(
  secret: string,
  timestamp: string,
  rawBody: string
): string {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
  );
}

export const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Constant-time verification of an AgentPhone webhook signature.
 * Rejects malformed or stale (>5 min skew) timestamps.
 */
export function verifySignature(params: {
  secret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
  nowMs?: number;
}): boolean {
  const { secret, timestamp, rawBody, signature } = params;
  const nowMs = params.nowMs ?? Date.now();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs - ts * 1000) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(computeSignature(secret, timestamp, rawBody));
  const given = Buffer.from(signature ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
