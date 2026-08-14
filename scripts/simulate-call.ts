/**
 * End-to-end webhook simulation against a running server (default
 * http://localhost:3000). Signs scripted conversations exactly like
 * AgentPhone and asserts the NDJSON responses for three scenarios:
 * on-list guest, off-list guest, general "package" inquiry.
 *
 * NOTE: this exercises the real stack — Neon writes, Pushover notifications,
 * and a real PATCH of the AgentPhone agent's transferNumber will happen.
 *
 *   npm run dev            # in another terminal
 *   npx tsx scripts/simulate-call.ts [baseUrl]
 */
import { randomUUID } from "node:crypto";
import { loadEnv } from "./env";

loadEnv();

const BASE = process.argv[2] ?? "http://localhost:3000";
const WEBHOOK = `${BASE}/api/agentphone/webhook`;
const SECRET = process.env.AGENTPHONE_WEBHOOK_SECRET ?? "";
// letters only — this id is embedded in a simulated guest *name*
const runId = Array.from({ length: 6 }, () =>
  String.fromCharCode(97 + Math.floor(Math.random() * 26))
).join("");

let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function post(
  payload: object,
  opts: { unsigned?: boolean; webhookId?: string } = {}
): Promise<{ status: number; chunks: Array<Record<string, unknown>> }> {
  const { computeSignature } = await import("../src/lib/agentphone/signature");
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Webhook-Timestamp": ts,
    "X-Webhook-ID": opts.webhookId ?? `sim_${randomUUID()}`,
  };
  if (!opts.unsigned) {
    headers["X-Webhook-Signature"] = computeSignature(SECRET, ts, raw);
  }
  const res = await fetch(WEBHOOK, { method: "POST", headers, body: raw });
  const text = await res.text();
  const chunks = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { raw: line };
      }
    });
  return { status: res.status, chunks };
}

function voiceMessage(callId: string, transcript: string) {
  return {
    event: "agent.message",
    channel: "voice",
    timestamp: new Date().toISOString(),
    agentId: process.env.AGENTPHONE_AGENT_ID,
    data: {
      callId,
      from: "+16195550100",
      to: process.env.AGENTPHONE_NUMBER,
      status: "in-progress",
      transcript,
      confidence: 0.97,
      direction: "inbound",
    },
    conversationState: null,
    recentHistory: [],
  };
}

function callEnded(
  callId: string,
  turns: Array<{ role: string; content: string }>
) {
  return {
    event: "agent.call_ended",
    channel: "voice",
    timestamp: new Date().toISOString(),
    agentId: process.env.AGENTPHONE_AGENT_ID,
    data: {
      callId,
      from: "+16195550100",
      to: process.env.AGENTPHONE_NUMBER,
      direction: "inbound",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date().toISOString(),
      durationSeconds: 60,
      disconnectionReason: "agent_hangup",
      summary: `Simulated call ${callId}`,
    },
    transcript: turns,
  };
}

function finalChunk(chunks: Array<Record<string, unknown>>) {
  return chunks[chunks.length - 1] ?? {};
}

function finalText(chunks: Array<Record<string, unknown>>): string {
  return String(finalChunk(chunks).text ?? "");
}

function allText(chunks: Array<Record<string, unknown>>): string {
  return chunks.map((c) => String(c.text ?? "")).join(" ");
}

async function outcomeOf(callId: string): Promise<string | null> {
  const { db } = await import("../src/lib/db");
  const rows = await db()`
    select outcome from calls where agentphone_call_id = ${callId}`;
  return (rows[0]?.outcome as string) ?? null;
}

async function scenarioOnList() {
  console.log("\nScenario 1: on-list guest");
  const { db } = await import("../src/lib/db");
  const guestName = `Simone Trial${runId}`;
  await db()`
    insert into guests (name, starts_at, ends_at)
    values (${guestName}, now() - interval '1 hour', now() + interval '1 hour')`;
  const callId = `sim_onlist_${runId}`;

  const t1 = await post(voiceMessage(callId, ""));
  check("greeting spoken", finalText(t1.chunks).includes("concierge assistant"));

  const t2 = await post(
    voiceMessage(callId, `I have ${guestName} here in the lobby`)
  );
  check("guest admitted", finalText(t2.chunks).includes("send them up"));
  check("hangup after admit", finalChunk(t2.chunks).hangup === true);

  await post(
    callEnded(callId, [
      { role: "user", content: `I have ${guestName} here in the lobby` },
      { role: "agent", content: "It's okay to send them up." },
    ])
  );
  check("outcome guest_admitted", (await outcomeOf(callId)) === "guest_admitted");
}

async function scenarioOffList() {
  console.log("\nScenario 2: off-list guest");
  const callId = `sim_offlist_${runId}`;
  const t1 = await post(voiceMessage(callId, "Hello"));
  check("greeting spoken", finalText(t1.chunks).includes("concierge assistant"));

  const t2 = await post(
    voiceMessage(callId, "I have Nobody Nowhere here in the lobby")
  );
  check(
    "auto-extracted miss re-asks the name",
    finalText(t2.chunks).toLowerCase().includes("name")
  );

  // Ack-gated: the deny turn holds ~20s for an ack, then offers a message.
  const t3 = await post(voiceMessage(callId, "Nobody Nowhere"));
  check("denied on explicit name", allText(t3.chunks).includes("don't see them"));
  check(
    "no blind transfer — offers message after hold",
    finalText(t3.chunks).includes("take a message") &&
      finalChunk(t3.chunks).action === undefined
  );

  await post(
    callEnded(callId, [
      { role: "user", content: "I have Nobody Nowhere here in the lobby" },
      { role: "agent", content: "Please hold." },
    ])
  );
  check(
    "outcome no_match_transferred",
    (await outcomeOf(callId)) === "no_match_transferred"
  );
}

async function scenarioPackage() {
  console.log("\nScenario 3: general inquiry (package)");
  const callId = `sim_package_${runId}`;
  const t1 = await post(voiceMessage(callId, ""));
  check("greeting spoken", finalText(t1.chunks).includes("concierge assistant"));

  const t2 = await post(
    voiceMessage(callId, "There's a package for you at the front desk")
  );
  check("holds the caller", allText(t2.chunks).toLowerCase().includes("hold"));
  check(
    "no blind transfer — offers message after hold",
    finalText(t2.chunks).includes("take a message")
  );

  await post(
    callEnded(callId, [
      { role: "user", content: "There's a package for you at the front desk" },
      { role: "agent", content: "Please hold." },
    ])
  );
  check(
    "outcome transfer_attempted",
    (await outcomeOf(callId)) === "transfer_attempted"
  );
}

async function scenarioSecurity() {
  console.log("\nSecurity checks");
  const unsigned = await post(voiceMessage(`sim_forged_${runId}`, "hi"), {
    unsigned: true,
  });
  check("unsigned POST rejected with 401", unsigned.status === 401);
  check(
    "forged call created no record",
    (await outcomeOf(`sim_forged_${runId}`)) === null
  );

  // Replay: same X-Webhook-ID twice — second delivery must be skipped.
  const { db } = await import("../src/lib/db");
  const replayCall = `sim_replay_${runId}`;
  const webhookId = `sim_replay_id_${runId}`;
  await post(voiceMessage(replayCall, "Hello"), { webhookId });
  const replay = await post(voiceMessage(replayCall, "Hello"), { webhookId });
  const turns = await db()`
    select count(*)::int as n from call_turns
    where role = 'agent'
      and call_id = (select id from calls where agentphone_call_id = ${replayCall})`;
  check("replayed webhook-id returns 200", replay.status === 200);
  check(
    "replayed webhook-id skipped (no duplicate side effects)",
    turns[0]?.n === 1,
    `agent turns recorded: ${turns[0]?.n}`
  );
}

async function cleanup() {
  const { db } = await import("../src/lib/db");
  const ids = await db()`
    select id from calls where agentphone_call_id like ${"sim_%" + runId}`;
  for (const row of ids) {
    await db()`delete from call_turns where call_id = ${row.id}`;
    await db()`delete from messages where call_id = ${row.id}`;
  }
  await db()`delete from calls where agentphone_call_id like ${"sim_%" + runId}`;
  await db()`delete from guests where name like ${"%Trial" + runId}`;
}

async function main() {
  console.log(`Simulating against ${WEBHOOK} (run ${runId})`);
  if (!SECRET) {
    console.error("AGENTPHONE_WEBHOOK_SECRET not set");
    process.exit(1);
  }
  try {
    await scenarioOnList();
    await scenarioOffList();
    await scenarioPackage();
    await scenarioSecurity();
  } finally {
    await cleanup();
  }
  console.log(
    failures === 0 ? "\nAll simulation checks passed." : `\n${failures} FAILED.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
