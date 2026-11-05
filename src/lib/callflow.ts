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
  | "HOLDING"
  | "TAKE_MESSAGE"
  | "CONFIRM_MESSAGE"
  | "DONE";

export interface CallState {
  phase: CallPhase;
  messageParts?: string[];
  /** number of clarification re-asks already used (loop guard) */
  clarifies?: number;
  /** true after we already asked once for first + last name */
  askedFullName?: boolean;
  /** caller utterances answered while a legacy transfer-ack hold was running */
  holds?: number;
  /** active guest {id,name} snapshot loaded once per call (route-managed) */
  guestSnapshot?: Array<{ id: string; name: string }>;
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
  /** Route may stream a short interim filler before the final reply. */
  lookupPending?: boolean;
}

export const GREETING_TEXT =
  "Hi, Scott and Monica's concierge — how can I help?";

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

// Name tokens only — no periods/location words — so
// "Sarah Connor. Is she allowed…" and "John Smith here in the lobby" stay clean.
const NAME_PART =
  "(?!here|there|waiting|downstairs|lobby|named|called)[A-Za-z][A-Za-z'’-]*";
const NAME = `${NAME_PART}(?:\\s+${NAME_PART}){0,3}`;
const NAME_PATTERNS: RegExp[] = [
  new RegExp(
    `(?:i have|i've got|we have|there is|there's)\\s+(?:an?\\s+)?(?:visitor|guest)?\\s*(?:named|called|name is)?\\s*(${NAME})\\s+(?:here|in the lobby|at the front desk|downstairs|for you|to see|waiting)`,
    "i"
  ),
  new RegExp(
    `(?:visitor|guest)\\s+(?:named|called|name is|is)\\s+(?:an?\\s+|the\\s+)?(${NAME})\\b`,
    "i"
  ),
  new RegExp(
    `(?:it is|it's|this is|named|called|name is)\\s+(?:an?\\s+|the\\s+)?(${NAME})\\b`,
    "i"
  ),
  new RegExp(
    `^(${NAME})\\s+is\\s+(?:here|in the lobby|at the front desk|downstairs|waiting)`,
    "i"
  ),
];

// Require a real separator before the marker so leading name tokens like
// "Will"/"May"/"Do"/"Can" are kept; those four also need a following word so
// "John May" stays intact while "John Smith. Can he come up?" still strips.
const TRAILING_CLAUSE_RE =
  /(?:\s*[,.]\s*|\s+)(?:(?:is|are|was|were|could|should|would|does|did|allowed|ok|okay|please|thanks|thank you)\b|(?:can|will|may|do)\b(?=\s+\S)).*$/i;

// Words that can never be a visitor's name (STT phrasing debris — a real call
// once captured "here" as the name and wrongly denied the guest).
const NON_NAME_RE =
  /^(a|an|the|for|to|is|it|someone|somebody|here|there|them|him|her|you|visitor|guest|waiting|lobby)$/i;

function plausibleName(candidate: string | undefined): string | null {
  const c = candidate?.trim().replace(/^(an?|the)\s+/i, "");
  if (!c) return null;
  if (NON_NAME_RE.test(c)) return null; // exact filler words ("here", "visitor", …)
  // location/delivery phrases are never names, but a name may CONTAIN a filler
  // word (the acceptance-test guest is literally called "Test Visitor")
  if (/\b(front desk|lobby|package|delivery)\b/i.test(c)) return null;
  if (/^(visitor|guest)\b/i.test(c)) return null; // "visitor John" is phrasing debris
  return c;
}

/** Strip lead-ins and trailing questions so only the person-name remains. */
export function cleanSpokenName(utterance: string): string {
  return utterance
    .trim()
    .replace(/^((yes|yeah|yep|okay|ok|um|uh|so|well)[,.!\s]+)+/i, "")
    .replace(/^(his|her|their)\s+name\s+is\s+/i, "")
    .replace(/^(the\s+)?name\s+is\s+/i, "")
    .replace(/^(it\s+is|it's|its|this\s+is|that\s+would\s+be)\s+/i, "")
    .replace(/^(an?|the)\s+/i, "")
    .replace(TRAILING_CLAUSE_RE, "")
    .replace(/[.!?,;:]+$/g, "")
    .trim();
}

export function extractName(utterance: string): string | null {
  // Prefer later sentences — "… Her name is Sarah Connor. Is she allowed…"
  const sentences = utterance
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const order =
    sentences.length > 1 ? [...sentences].reverse() : [utterance.trim()];
  for (const sentence of order) {
    const u = sentence.replace(/[.!?]+$/g, "").trim();
    for (const re of NAME_PATTERNS) {
      const name = plausibleName(cleanSpokenName(u.match(re)?.[1] ?? ""));
      if (name) return name;
    }
  }
  return null;
}

/** Single-token or otherwise incomplete name → re-ask for first + last. */
export function isPartialName(name: string): boolean {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length < 2;
}

/** STT sometimes delivers dangling fragments ("I have a ") as whole turns —
 *  never act on them, ask again instead. */
function isIncomplete(utterance: string): boolean {
  const u = utterance.trim();
  if (!u) return false; // empty is handled by GREETING_ONLY_RE
  const words = u.replace(/[.!?,]+$/g, "").split(/\s+/);
  if (/\b(a|an|the|to|for|of|and|is|uh|um|with)$/i.test(u.replace(/[.!?,\s]+$/g, ""))) {
    return true;
  }
  return words.length < 2 && !VISITOR_RE.test(u) && !PACKAGE_RE.test(u);
}

export function targetName(target: TransferTarget): string {
  return target === "monica" ? "Monica" : "Scott";
}

/** The route fires this only when a transfer actually executes. */
export function transferNotifyEffect(target: TransferTarget): Effect {
  const n = targetName(target);
  return {
    type: "notify",
    event: "call.transfer",
    title: `📲 Transferring to ${n}`,
    message: `Concierge transferring to ${n}`,
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
    reply: `Of course — connecting you to ${targetName(target)} now.`,
    nextState: { phase: "DONE" },
    action: "transfer",
    transferTarget: target,
    effects: [{ type: "outcome", outcome: "transfer_attempted" }],
  };
}

async function matchAndRespond(
  name: string,
  deps: CallflowDeps,
  opts: {
    denyOnMiss: boolean;
    /** Re-ask once for first+last when the heard name is partial/unclear. */
    allowPartialReask?: boolean;
    state?: CallState;
  } = { denyOnMiss: true }
): Promise<CallflowResult> {
  let result: GuestMatch;
  try {
    result = await deps.matchGuest(name);
  } catch (e) {
    // Fail closed: never admit on a lookup error — transfer immediately.
    return {
      reply:
        "I'm having a little trouble checking the list. Connecting you to Scott now.",
      nextState: { phase: "DONE" },
      action: "transfer",
      transferTarget: "scott",
      lookupPending: true,
      effects: [
        {
          type: "notify",
          event: "system.error",
          message: `Guest lookup failed for "${name}" — failing closed to transfer (${String(e)})`,
        },
        { type: "outcome", outcome: "error" },
      ],
    };
  }
  if (result.match) {
    return {
      reply: `Yes — ${result.match.name} is expected. It's okay to send them up. Thank you!`,
      nextState: { phase: "DONE" },
      action: "hangup",
      lookupPending: true,
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
  if (!opts.denyOnMiss) {
    // The name was auto-extracted from the announcement and may be STT noise —
    // confirm it explicitly before ever denying anyone.
    return {
      reply: "I may have misheard — what's the visitor's name, exactly?",
      nextState: { phase: "ASK_NAME" },
      lookupPending: true,
      effects: [],
    };
  }
  // Partial / single-token miss: ask once for first and last before denying.
  if (opts.allowPartialReask && isPartialName(name)) {
    return {
      reply: "Could I get the guest's first and last name?",
      nextState: {
        phase: "ASK_NAME",
        askedFullName: true,
        clarifies: opts.state?.clarifies,
      },
      lookupPending: true,
      effects: [],
    };
  }
  return {
    reply:
      "I don't see them on the approved list. Connecting you to Scott or Monica now.",
    nextState: { phase: "DONE" },
    action: "transfer",
    transferTarget: "scott",
    lookupPending: true,
    effects: [
      {
        type: "notify",
        event: "guest.denied",
        message: `'${name}' not on list — transferring`,
      },
      { type: "outcome", outcome: "no_match_transferred" },
    ],
  };
}

async function handleIntent(
  utterance: string,
  deps: CallflowDeps,
  state?: CallState
): Promise<CallflowResult> {
  if (isIncomplete(utterance)) {
    const clarifies = state?.clarifies ?? 0;
    if (clarifies < 2) {
      return {
        reply: "Sorry — could you say that again?",
        nextState: { phase: "INTENT", clarifies: clarifies + 1 },
        effects: [],
      };
    }
    // Repeatedly unintelligible — fail safe to a transfer, never guess.
    return generalTransfer("scott");
  }
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
  // Auto-extracted name: admit on a match, but never deny on a miss —
  // re-ask for the name explicitly instead (denyOnMiss: false).
  return matchAndRespond(name, deps, { denyOnMiss: false });
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
      const inner = await handleIntent(utterance, deps, state);
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
      return handleIntent(utterance, deps, state);
    }

    case "ASK_NAME": {
      if (GOODBYE_RE.test(utterance)) return politeClose(true);
      // The reply here is matched (and can be denied) as a NAME — so phrasing
      // debris ("a visitor for them") must re-ask, never run a doomed lookup.
      const name = plausibleName(cleanSpokenName(utterance));
      if (!name) {
        const clarifies = state.clarifies ?? 0;
        if (clarifies < 2) {
          return {
            reply: state.askedFullName
              ? "Sorry — could I get the first and last name?"
              : "Sorry — what was the visitor's name?",
            nextState: { ...state, clarifies: clarifies + 1 },
            effects: [],
          };
        }
        return generalTransfer("scott");
      }
      return matchAndRespond(name, deps, {
        denyOnMiss: true,
        allowPartialReask: !state.askedFullName,
        state,
      });
    }

    case "HOLDING": {
      // Legacy ack-hold phase — transfers are immediate now. Connect right away
      // instead of leaving the caller in silence.
      return generalTransfer("scott");
    }

    case "TAKE_MESSAGE": {
      if (!utterance || DONE_RE.test(utterance) || GOODBYE_RE.test(utterance)) {
        // No outcome effect: keep the earlier outcome (e.g. no_match_transferred)
        // rather than overwriting it with a generic hangup.
        return {
          reply:
            "No problem — I'll let Scott and Monica know you called. Thank you! Goodbye.",
          nextState: { phase: "DONE" },
          action: "hangup",
          effects: [],
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

/** Applied by the route when a transfer can't complete (PATCH failed):
 *  apologize and fall back to message taking. */
export function transferFailedResult(
  prev: CallflowResult,
  reason: "no_ack" | "patch_failed" = "patch_failed"
): CallflowResult {
  return {
    reply:
      "I'm sorry — I wasn't able to reach Scott or Monica just now. I can take a message; go ahead whenever you're ready.",
    nextState: { phase: "TAKE_MESSAGE", messageParts: [] },
    effects:
      reason === "patch_failed"
        ? [
            ...prev.effects,
            {
              type: "notify",
              event: "system.error",
              message: "Transfer setup failed — falling back to message taking",
            },
          ]
        : [...prev.effects],
  };
}
