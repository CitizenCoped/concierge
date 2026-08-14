import { describe, expect, it } from "vitest";
import { computeSignature, verifySignature } from "./signature";

const secret = "whsec_test_secret";
const body = JSON.stringify({ event: "agent.message", data: { callId: "c1" } });

function nowTs(offsetSec = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSec);
}

describe("webhook signature", () => {
  it("accepts a valid signature", () => {
    const ts = nowTs();
    const sig = computeSignature(secret, ts, body);
    expect(
      verifySignature({ secret, timestamp: ts, rawBody: body, signature: sig })
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = nowTs();
    const sig = computeSignature(secret, ts, body);
    expect(
      verifySignature({
        secret,
        timestamp: ts,
        rawBody: body + " ",
        signature: sig,
      })
    ).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const ts = nowTs();
    const sig = computeSignature("whsec_other", ts, body);
    expect(
      verifySignature({ secret, timestamp: ts, rawBody: body, signature: sig })
    ).toBe(false);
  });

  it("rejects a stale timestamp (>5 min)", () => {
    const ts = nowTs(-360);
    const sig = computeSignature(secret, ts, body);
    expect(
      verifySignature({ secret, timestamp: ts, rawBody: body, signature: sig })
    ).toBe(false);
  });

  it("rejects a future timestamp (>5 min)", () => {
    const ts = nowTs(360);
    const sig = computeSignature(secret, ts, body);
    expect(
      verifySignature({ secret, timestamp: ts, rawBody: body, signature: sig })
    ).toBe(false);
  });

  it("rejects malformed timestamps and empty signatures", () => {
    expect(
      verifySignature({
        secret,
        timestamp: "not-a-number",
        rawBody: body,
        signature: computeSignature(secret, "not-a-number", body),
      })
    ).toBe(false);
    expect(
      verifySignature({ secret, timestamp: nowTs(), rawBody: body, signature: "" })
    ).toBe(false);
  });
});
