import type { GuestMatch } from "./db/guests";
import type { NotifyEvent } from "./notify";

// Pure call-flow state machine: (state, utterance, deps) → (reply, nextState,
// effects). No I/O here beyond the injected matchGuest — the webhook route
// executes effects (notify, DB writes) and the transfer PATCH.
// Any change here must be mirrored in PROMPT.md §5 and callflow.test.ts.

export type TransferTarget = "scott" | "monica";

export type CallOutcome =
  | "guest_admitted"
  | "no_match_transferred"
  | "transfer_attempted"
  | "message_taken"
  | "hangup"
  | "error"
  | "in_progress";

export type CallPhase =
  | "GREETING"
  | "INTENT"
  | "ASK_NAME"
  | "TAKE_MESSAGE"
  | "CONFIRM_MESSAGE"
  | "DONE";

export interface CallState {
  phase: CallPhase;
  messageParts?: string[];
}

export const INITIAL_STATE: CallState = { phase: "GREETING" };

export type Effect =
  | { type: "notify"; event: NotifyEvent; title?: string; message: string }
  | { type: "outcome"; outcome: CallOutcome; guestId?: string }
  | { type: "saveMessage"; body: string };

export interface CallflowDeps {
  matchGuest(name: string): Promise<GuestMatch>;
}

export interface CallflowResult {
  reply: string;
  nextState: CallState;
  action?: "transfer" | "hangup";
  transferTarget?: TransferTarget;
  effects: Effect[];
}

export const GREETING_TEXT =
  "Hi, this is Scott and Monica's automated concierge assistant. How can I help you?";

const GREETING_ONLY_RE =
  /^\s*(hi|hello|hey|hi there|good (morning|afternoon|evening))?[.!,?\s]*$/i;
const GOODBYE_RE =
  /\b(goodbye|good ?bye|bye|that(’|'| i)?s all|nothing (else|further)|no message|we're good|all set)\b/i;
const DONE_RE =
  /^\s*(no|nope|no thanks?|nothing|nothing else|that(’|'| i)?s (it|all|everything))\b/i;
const MONICA_RE = /\bmonica\b/i;
const PACKAGE_RE =
  /\b(package|parcel|deliver|delivery|mail|food|groceries|maintenance|repair|leak|noise|question|billing|elevator|amenity|hoa|garage|parking)\b/i;
const VISITOR_RE =
  /\b(visitor|guest|here to see|here for|is here|coming up|send (him|her|them) up|has arrived|arrived|lobby|front desk|downstairs|to visit|stopping by|wants? to (come|go) up|let (him|her|them) (up|in))\b|\bha(?:ve|s)\b.*\bhere\b/i;

const NAME = "[A-Za-z][A-Za-z .'’-]*?";
const NAME_PATTERNS: RegExp[] = [
  new RegExp(
    `(?:i have|i've got|we have|there is|there's)\\s+(?:an?\\s+)?(?:visitor|guest)?\\s*(?:named|called|name is)?\\s*(${NAME})\\s+(?:here|in the lobby|at the front desk|downstairs|for you|to see|waiting)`,
    "i"
  ),
  new RegExp(`(?:visitor|guest)\\s+(?:named|called|name is|is)\\s+(${NAME})$`, "i"),
  new RegExp(
    `^(${NAME})\\s+is\\s+(?:here|in the lobby|at the front desk|downstairs|waiting)`,
    "i"
  ),
];

function extractName(utterance: string): string | null {
  const u = utterance.trim().replace(/[.!?]+$/, "");
  for (const re of NAME_PATTERNS) {
    const m = u.match(re);
    const candidate = m?.[1]?.trim();
    if (
      candidate &&
      !/^(a|an|the|for|to|is|someone|somebody)$/i.test(candidate) &&
      !/\b(visitor|guest|package|delivery)\b/i.test(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

function cleanSpokenName(utterance: string): string {
  return utterance
    .trim()
    .replace(/^(his|her|their)\s+name\s+is\s+/i, "")
    .replace(/^(the\s+)?name\s+is\s+/i, "")
    .replace(/^(it\s+is|it's|its|this\s+is|that\s+would\s+be)\s+/i, "")
    .replace(/[.!?,]+$/g, "")
    .trim();
}

function targetName(target: TransferTarget): string {
  return target === "monica" ? "Monica" : "Scott";
}

function transferNotifyEffect(target: TransferTarget): Effect {
  const n = targetName(target);
  return {
    type: "notify",
    event: "call.transfer",
    title: `📲 Transferring to ${n}`,
    message: `Concierge holding; transferring to ${n}`,
  };
}

function politeClose(withOutcome: boolean): CallflowResult {
  return {
    reply: "Okay — thank you! Goodbye.",
    nextState: { phase: "DONE" },
    action: "hangup",
    effects: withOutcome ? [{ type: "outcome", outcome: "hangup" }] : [],
  };
}

function generalTransfer(target: TransferTarget): CallflowResult {
  return {
    reply: "Of course — please hold for just a moment while I connect you.",
    nextState: { phase: "DONE" },
    action: "transfer",
    transferTarget: target,
    effects: [
      transferNotifyEffect(target),
      { type: "outcome", outcome: "transfer_attempted" },
    ],
  };
}

async function matchAndRespond(
  name: string,
  deps: CallflowDeps
): Promise<CallflowResult> {
  let result: GuestMatch;
  try {
    result = await deps.matchGuest(name);
  } catch (e) {
    // Fail closed: never admit on a lookup error — hold and transfer.
    return {
      reply:
        "I'm having a little trouble checking the list. Please hold for just a moment while I check with Scott or Monica.",
      nextState: { phase: "DONE" },
      action: "transfer",
      transferTarget: "scott",
      effects: [
        {
          type: "notify",
          event: "system.error",
          message: `Guest lookup failed for "${name}" — failing closed to transfer (${String(e)})`,
        },
        transferNotifyEffect("scott"),
        { type: "outcome", outcome: "error" },
      ],
    };
  }
  if (result.match) {
    return {
      reply: `Yes — ${result.match.name} is expected. It's okay to send them up. Thank you!`,
      nextState: { phase: "DONE" },
      action: "hangup",
      effects: [
        {
          type: "notify",
          event: "guest.admitted",
          message: `Guest = ${result.match.name} has been let into the building`,
        },
        { type: "outcome", outcome: "guest_admitted", guestId: result.match.id },
      ],
    };
  }
  return {
    reply:
      "I don't see them on the approved list. Please hold for just a moment while I check with Scott or Monica.",
    nextState: { phase: "DONE" },
    action: "transfer",
    transferTarget: "scott",
    effects: [
      {
        type: "notify",
        event: "guest.denied",
        message: `'${name}' not on list — transferring`,
      },
      transferNotifyEffect("scott"),
      { type: "outcome", outcome: "no_match_transferred" },
    ],
  };
}

async function handleIntent(
  utterance: string,
  deps: CallflowDeps
): Promise<CallflowResult> {
  const isVisitor = VISITOR_RE.test(utterance) && !PACKAGE_RE.test(utterance);
  if (!isVisitor) {
    return generalTransfer(MONICA_RE.test(utterance) ? "monica" : "scott");
  }
  const name = extractName(utterance);
  if (!name) {
    return {
      reply: "Of course — what's the visitor's name?",
      nextState: { phase: "ASK_NAME" },
      effects: [],
    };
  }
  return matchAndRespond(name, deps);
}

export async function step(
  state: CallState,
  utteranceRaw: string,
  deps: CallflowDeps
): Promise<CallflowResult> {
  const utterance = (utteranceRaw ?? "").trim();
  switch (state.phase) {
    case "GREETING": {
      const started: Effect = {
        type: "notify",
        event: "call.started",
        message: "Front desk is calling the concierge line…",
      };
      if (GREETING_ONLY_RE.test(utterance)) {
        return {
          reply: GREETING_TEXT,
          nextState: { phase: "INTENT" },
          effects: [started],
        };
      }
      // The agent-level beginMessage already greeted the caller — when their
      // first utterance has content, answer it directly without re-greeting.
      const inner = await handleIntent(utterance, deps);
      return { ...inner, effects: [started, ...inner.effects] };
    }

    case "INTENT": {
      if (GOODBYE_RE.test(utterance) || DONE_RE.test(utterance)) {
        return politeClose(true);
      }
      if (GREETING_ONLY_RE.test(utterance)) {
        return {
          reply: "How can I help you?",
          nextState: state,
          effects: [],
        };
      }
      return handleIntent(utterance, deps);
    }

    case "ASK_NAME": {
      if (GOODBYE_RE.test(utterance)) return politeClose(true);
      const name = cleanSpokenName(utterance);
      if (!name) {
        return {
          reply: "Sorry — what was the visitor's name?",
          nextState: state,
          effects: [],
        };
      }
      return matchAndRespond(name, deps);
    }

    case "TAKE_MESSAGE": {
      if (!utterance || DONE_RE.test(utterance) || GOODBYE_RE.test(utterance)) {
        return {
          reply:
            "No problem — I'll let Scott and Monica know you called. Thank you! Goodbye.",
          nextState: { phase: "DONE" },
          action: "hangup",
          effects: [{ type: "outcome", outcome: "hangup" }],
        };
      }
      return {
        reply: "Got it. Anything else?",
        nextState: {
          phase: "CONFIRM_MESSAGE",
          messageParts: [...(state.messageParts ?? []), utterance],
        },
        effects: [],
      };
    }

    case "CONFIRM_MESSAGE": {
      if (!utterance || DONE_RE.test(utterance) || GOODBYE_RE.test(utterance)) {
        const body = (state.messageParts ?? []).join(" ");
        return {
          reply:
            "Thank you — I'll pass that along to Scott and Monica right away. Goodbye!",
          nextState: { phase: "DONE" },
          action: "hangup",
          effects: [
            { type: "saveMessage", body },
            {
              type: "notify",
              event: "message.taken",
              message: `Message From Concierge = ${body}`,
            },
            { type: "outcome", outcome: "message_taken" },
          ],
        };
      }
      return {
        reply: "Got it. Anything else?",
        nextState: {
          phase: "CONFIRM_MESSAGE",
          messageParts: [...(state.messageParts ?? []), utterance],
        },
        effects: [],
      };
    }

    case "DONE":
      return politeClose(false);
  }
}

/** Applied by the route when the transfer PATCH fails: never transfer blind —
 *  apologize and fall back to message taking. Drops the call.transfer notify. */
export function transferFailedResult(prev: CallflowResult): CallflowResult {
  return {
    reply:
      "I'm sorry — I wasn't able to reach Scott or Monica just now. I can take a message; go ahead whenever you're ready.",
    nextState: { phase: "TAKE_MESSAGE", messageParts: [] },
    effects: [
      ...prev.effects.filter(
        (e) => !(e.type === "notify" && e.event === "call.transfer")
      ),
      {
        type: "notify",
        event: "system.error",
        message: "Transfer setup failed — falling back to message taking",
      },
    ],
  };
}
