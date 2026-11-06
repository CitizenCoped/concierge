import { db } from "@/lib/db";
import {
  listActiveGuests,
  matchGuestAgainst,
  type GuestNameRow,
} from "@/lib/db/guests";
import { answerFromGuestInfo } from "@/lib/guestinfo";
import { verifySignature } from "@/lib/agentphone/signature";
import { setTransferNumber } from "@/lib/agentphone/client";
import { notify } from "@/lib/notify";
import {
  INITIAL_STATE,
  step,
  transferFailedResult,
  transferNotifyEffect,
  type CallOutcome,
  type CallState,
  type CallflowResult,
  type TransferTarget,
} from "@/lib/callflow";
import { mergePersistedCallState } from "@/lib/callstate";

export const runtime = "nodejs";
export const maxDuration = 60;

// Cold transfer target. Default SCOTT_PHONE; swap that env later for a number
// that rings both Scott and Monica if desired. Monica is still selectable when
// the concierge asks for her by name.
function phoneFor(target: TransferTarget): string {
  return target === "monica"
    ? (process.env.MONICA_PHONE ?? "")
    : (process.env.SCOTT_PHONE ?? "");
}

const FALLBACK_TEXT =
  "I'm sorry, I'm having trouble — please hold while I transfer you.";

interface VoiceData {
  callId?: string;
  from?: string;
  to?: string;
  transcript?: string;
  status?: string;
}

interface WebhookPayload {
  event?: string;
  channel?: string;
  data?: VoiceData & {
    startedAt?: string;
    endedAt?: string;
    summary?: string;
    transcript?: unknown;
  };
  transcript?: Array<{ role?: string; content?: string }>;
}

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  const ok = verifySignature({
    secret: process.env.AGENTPHONE_WEBHOOK_SECRET ?? "",
    timestamp: req.headers.get("x-webhook-timestamp") ?? "",
    rawBody: raw,
    signature: req.headers.get("x-webhook-signature") ?? "",
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  // Idempotency: claim the webhook id before any side effect.
  const webhookId = req.headers.get("x-webhook-id");
  if (webhookId) {
    try {
      const claimed = await db()`
        insert into webhook_events (webhook_id) values (${webhookId})
        on conflict (webhook_id) do nothing
        returning webhook_id`;
      if (claimed.length === 0) return Response.json({});
    } catch (e) {
      console.error("webhook: dedupe insert failed", e);
      // continue — the flow itself fails closed on DB errors
    }
  }

  let payload: WebhookPayload | null = null;
  try {
    payload = JSON.parse(raw) as WebhookPayload;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object") {
    await notify({
      event: "system.error",
      message: "Webhook payload parse failure — failing closed",
    });
    await setTransferNumber(process.env.SCOTT_PHONE ?? "");
    return Response.json({ text: FALLBACK_TEXT, action: "transfer" });
  }

  if (payload.event === "agent.call_ended") return handleCallEnded(payload);
  if (payload.event === "agent.message" && payload.channel === "voice") {
    return handleVoiceMessage(payload);
  }
  console.log("webhook: ignoring event", payload.event, payload.channel);
  return Response.json({});
}

async function loadCall(
  callId: string,
  from: string | null
): Promise<{ id: string; state: CallState | null }> {
  const rows = await db()`
    insert into calls (agentphone_call_id, started_at, from_number, outcome, state)
    values (${callId}, now(), ${from}, 'in_progress', ${JSON.stringify(INITIAL_STATE)}::jsonb)
    on conflict (agentphone_call_id) do update
      set from_number = coalesce(calls.from_number, excluded.from_number)
    returning id, state`;
  return rows[0] as { id: string; state: CallState | null };
}

/** Load the active guest list once per call and reuse across turns. */
async function guestsForCall(state: CallState): Promise<GuestNameRow[]> {
  // undefined = never loaded; [] = loaded, no active guests.
  if (state.guestSnapshot !== undefined) return state.guestSnapshot;
  const rows = await listActiveGuests();
  return rows.map((g) => ({
    id: g.id,
    name: g.name,
    guest_info: g.guest_info,
  }));
}

function handleVoiceMessage(payload: WebhookPayload): Response {
  const data = payload.data ?? {};
  const callId = data.callId;
  const utterance = String(data.transcript ?? "");

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const write = (obj: Record<string, unknown>) =>
        controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      let result: CallflowResult | null = null;
      let callDbId: string | null = null;
      try {
        if (!callId) throw new Error("agent.message without data.callId");
        const call = await loadCall(callId, data.from ?? null);
        callDbId = call.id;
        const state = call.state ?? INITIAL_STATE;
        const snapshot = await guestsForCall(state);
        const deps = {
          matchGuest: async (name: string) => matchGuestAgainst(name, snapshot),
          answerGuestInfo: answerFromGuestInfo,
          transferAvailable: {
            scott: Boolean(process.env.SCOTT_PHONE?.trim()),
            monica: Boolean(process.env.MONICA_PHONE?.trim()),
          },
        };

        // Peek: only fill dead air when a guest lookup or notes Q&A is likely.
        const maybeLookup =
          state.phase === "ASK_NAME" ||
          ((state.phase === "GREETING" || state.phase === "INTENT") &&
            /\b(visitor|guest|here|lobby|name|allowed|park|garage|access|expected|instructions?|delivery|tell (her|him|them))\b/i.test(
              utterance
            ));
        if (maybeLookup) {
          write({ text: "One moment.", interim: true });
        }

        result = await step(state, utterance, deps);
        // Merge for persistence: intentional activeGuest/messageSaved clears
        // must stick — never `??` prior guest (resurrects cleared identity).
        result = {
          ...result,
          nextState: mergePersistedCallState(
            result.nextState,
            state,
            snapshot
          ),
        };

        if (result.action === "transfer") {
          const target: TransferTarget = result.transferTarget ?? "scott";
          const number = phoneFor(target);
          const patched = number ? await setTransferNumber(number) : false;
          if (patched) {
            result.effects.push(transferNotifyEffect(target));
            write({ text: result.reply, action: "transfer" });
          } else {
            result = transferFailedResult(result, "patch_failed");
            result = {
              ...result,
              nextState: mergePersistedCallState(
                result.nextState,
                state,
                snapshot
              ),
            };
            write({ text: result.reply });
          }
        } else {
          const final: Record<string, unknown> = { text: result.reply };
          if (result.action === "hangup") {
            final.action = "hangup";
            final.hangup = true;
          }
          write(final);
        }
      } catch (e) {
        console.error("webhook: voice turn error", e);
        // Fail closed: never admit on error — transfer to Scott.
        await setTransferNumber(process.env.SCOTT_PHONE ?? "");
        write({ text: FALLBACK_TEXT, action: "transfer" });
        result = null;
        await notify({
          event: "system.error",
          message: `Voice webhook error on call ${callId ?? "?"}: ${String(e)}`,
        });
        if (callId) {
          try {
            await db()`
              update calls set outcome = 'error'
              where agentphone_call_id = ${callId}`;
          } catch (dbErr) {
            console.error("webhook: failed to mark call errored", dbErr);
          }
        }
      } finally {
        if (result && callDbId) {
          try {
            await runEffects(result, callDbId, utterance);
          } catch (e) {
            console.error("webhook: effect execution failed", e);
          }
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

async function runEffects(
  result: CallflowResult,
  callDbId: string,
  utterance: string
): Promise<void> {
  const sql = db();
  if (utterance.trim()) {
    await sql`insert into call_turns (call_id, role, text)
              values (${callDbId}, 'caller', ${utterance.trim()})`;
  }
  await sql`insert into call_turns (call_id, role, text)
            values (${callDbId}, 'agent', ${result.reply})`;
  for (const effect of result.effects) {
    if (effect.type === "notify") {
      await notify({
        event: effect.event,
        title: effect.title,
        message: effect.message,
        url: `${process.env.APP_URL ?? ""}/calls`,
      });
    } else if (effect.type === "outcome") {
      await sql`update calls
                set outcome = ${effect.outcome},
                    matched_guest_id = coalesce(${effect.guestId ?? null}::uuid, matched_guest_id)
                where id = ${callDbId}`;
    } else if (effect.type === "saveMessage") {
      await sql`insert into messages (call_id, body)
                values (${callDbId}, ${effect.body})`;
    }
  }
  await sql`update calls set state = ${JSON.stringify(result.nextState)}::jsonb
            where id = ${callDbId}`;
}

async function handleCallEnded(payload: WebhookPayload): Promise<Response> {
  const data = payload.data ?? {};
  const callId = data.callId;
  if (!callId) return Response.json({});
  try {
    const rows = await db()`
      insert into calls (agentphone_call_id, started_at, ended_at, from_number,
                         outcome, summary, raw_call_ended)
      values (${callId}, ${data.startedAt ?? null}, ${data.endedAt ?? null},
              ${data.from ?? null}, 'hangup', ${data.summary ?? null},
              ${JSON.stringify(payload)}::jsonb)
      on conflict (agentphone_call_id) do update
        set ended_at = coalesce(excluded.ended_at, calls.ended_at),
            summary = coalesce(excluded.summary, calls.summary),
            raw_call_ended = excluded.raw_call_ended,
            outcome = case
              when calls.outcome is null or calls.outcome = 'in_progress'
              then 'hangup' else calls.outcome end
      returning id, outcome`;
    const call = rows[0] as { id: string; outcome: CallOutcome };
    const transcript = Array.isArray(payload.transcript)
      ? payload.transcript
      : Array.isArray(data.transcript)
        ? (data.transcript as Array<{ role?: string; content?: string }>)
        : [];
    if (transcript.length > 0) {
      // The platform transcript is authoritative — replace live-recorded turns.
      await db()`delete from call_turns where call_id = ${call.id}`;
      for (const turn of transcript) {
        await db()`insert into call_turns (call_id, role, text)
                   values (${call.id},
                           ${turn.role === "agent" ? "agent" : "caller"},
                           ${String(turn.content ?? "")})`;
      }
    }
    await notify({
      event: "call.ended",
      message: `Outcome: ${call.outcome}.${data.summary ? ` ${data.summary}` : ""}`,
      url: `${process.env.APP_URL ?? ""}/calls`,
    });
  } catch (e) {
    console.error("webhook: call_ended handling failed", e);
    await notify({
      event: "system.error",
      message: `call_ended persistence failed for ${callId}: ${String(e)}`,
    });
  }
  return Response.json({});
}
