/**
 * Smoke test: DB connectivity, Pushover auth, AgentPhone API auth, webhook
 * signature round-trip. With --notify, additionally sends one real
 * notification per event type through notify() (Pushover + Web Push + DB log).
 */
import { loadEnv } from "./env";

loadEnv();

const results: Array<[string, boolean, string?]> = [];

function report(name: string, ok: boolean, detail?: string) {
  results.push([name, ok, detail]);
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const { db } = await import("../src/lib/db");

  // 1. DB
  try {
    const rows = await db()`select 1 as ok`;
    report("Neon DB select 1", rows[0]?.ok === 1);
  } catch (e) {
    report("Neon DB select 1", false, String(e));
  }

  // 2. Pushover token validation (no message sent)
  try {
    const res = await fetch("https://api.pushover.net/1/users/validate.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: process.env.PUSHOVER_APP_TOKEN ?? "",
        user: process.env.PUSHOVER_USER_KEY ?? "",
      }),
    });
    const json = (await res.json()) as { status?: number };
    report("Pushover token/user valid", json.status === 1);
  } catch (e) {
    report("Pushover token/user valid", false, String(e));
  }

  // 3. AgentPhone API auth
  try {
    const res = await fetch("https://api.agentphone.ai/v1/agents", {
      headers: { Authorization: `Bearer ${process.env.AGENTPHONE_API_KEY}` },
    });
    report("AgentPhone API auth", res.status === 200, `HTTP ${res.status}`);
  } catch (e) {
    report("AgentPhone API auth", false, String(e));
  }

  // 4. Webhook signature round-trip
  try {
    const { computeSignature, verifySignature } = await import(
      "../src/lib/agentphone/signature"
    );
    const secret = process.env.AGENTPHONE_WEBHOOK_SECRET ?? "";
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ smoke: true });
    const sig = computeSignature(secret, ts, body);
    const good = verifySignature({ secret, timestamp: ts, rawBody: body, signature: sig });
    const badSig = verifySignature({ secret, timestamp: ts, rawBody: body, signature: sig.replace(/.$/, "0") });
    const stale = verifySignature({
      secret,
      timestamp: String(Math.floor(Date.now() / 1000) - 600),
      rawBody: body,
      signature: computeSignature(secret, String(Math.floor(Date.now() / 1000) - 600), body),
    });
    report(
      "Webhook signature round-trip",
      Boolean(secret) && good && !badSig && !stale
    );
  } catch (e) {
    report("Webhook signature round-trip", false, String(e));
  }

  // 5. Optional: one notification per event type
  if (process.argv.includes("--notify")) {
    const { notify, EVENT_TITLES } = await import("../src/lib/notify");
    const samples: Record<string, string> = {
      "call.started": "Front desk is calling the concierge line… (smoke test)",
      "guest.admitted": "Guest = Test Visitor has been let into the building (smoke test)",
      "guest.denied": "'Nobody Realname' not on list — transferring (smoke test)",
      "call.transfer": "Concierge holding; transferring to Scott (smoke test)",
      "message.taken": "Message From Concierge = smoke test message",
      "call.ended": "Smoke test call ended — outcome: none, this is a drill",
      "system.error": "Smoke test error event — everything is actually fine",
    };
    for (const event of Object.keys(EVENT_TITLES) as Array<keyof typeof EVENT_TITLES>) {
      const title =
        event === "call.transfer" ? "📲 Transferring to Scott" : undefined;
      await notify({ event, title, message: samples[event] });
      console.log(`   sent ${event}`);
    }
    report("notify() fan-out per event type", true, "confirm receipt on phone");
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(
    failed.length === 0
      ? "\nAll smoke checks passed."
      : `\n${failed.length} smoke check(s) FAILED.`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
