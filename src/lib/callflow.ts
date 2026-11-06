import type { GuestMatch, GuestNameRow } from "./db/guests";
import type { NotifyEvent } from "./notify";

// Pure call-flow state machine: (state, utterance, deps) → (reply, nextState,
// effects). No I/O here beyond the injected matchGuest / answerGuestInfo —
// the webhook route executes effects (notify, DB writes) and the transfer PATCH.
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
  | "OFFER_TRANSFER"
  | "HOLDING"
  | "TAKE_MESSAGE"
  | "CONFIRM_MESSAGE"
  | "DONE";

/** Guest identified earlier on this call (admit or notes Q&A). */
export interface ActiveGuest {
  id: string;
  name: string;
  guest_info?: string | null;
}

export interface CallState {
  phase: CallPhase;
  messageParts?: string[];
  /** number of clarification re-asks already used (loop guard) */
  clarifies?: number;
  /** true after we already asked once for first + last name */
  askedFullName?: boolean;
  /** caller utterances answered while a legacy transfer-ack hold was running */
  holds?: number;
  /** active guest snapshot loaded once per call (route-managed) */
  guestSnapshot?: Array<{ id: string; name: string; guest_info?: string | null }>;
  /** Last identified guest on this call — used for pronoun follow-ups. */
  activeGuest?: ActiveGuest;
}

export const INITIAL_STATE: CallState = { phase: "GREETING" };

export type Effect =
  | { type: "notify"; event: NotifyEvent; title?: string; message: string }
  | { type: "outcome"; outcome: CallOutcome; guestId?: string }
  | { type: "saveMessage"; body: string };

export interface GuestInfoQaInput {
  guestName: string;
  guestInfo: string;
  question: string;
}

export interface GuestInfoQaResult {
  answer: "yes" | "no" | "unclear";
  reply: string;
}

export interface CallflowDeps {
  matchGuest(name: string): Promise<GuestMatch>;
  /** Optional: answer a permission question from guest_info. Null → treat as unclear. */
  answerGuestInfo?(input: GuestInfoQaInput): Promise<GuestInfoQaResult | null>;
  /**
   * Which cold-transfer targets have a real phone configured.
   * Missing Monica must NOT silently route to Scott.
   */
  transferAvailable?: { scott: boolean; monica: boolean };
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
  "Hello, Scott and Monica's AI assistant here. What's up?";

const GREETING_ONLY_RE =
  /^\s*(hi|hello|hey|hi there|good (morning|afternoon|evening))?[.!,?\s]*$/i;
const GOODBYE_RE =
  /\b(goodbye|good ?bye|bye|that(’|'| i)?s all|nothing (else|further)|no message|we're good|all set)\b/i;
const DONE_RE =
  /^\s*(no|nope|no thanks?|nothing|nothing else|that(’|'| i)?s (it|all|everything))\b/i;
const YES_RE =
  /^\s*(yes|yeah|yep|yup|sure|please|ok|okay|go ahead|do it|connect (me|us)?)\b/i;
const NO_RE =
  /^\s*(no|nope|nah|no thanks?|not now|don't|do not|never ?mind)\b/i;
const SCOTT_RE = /\bscott\b/i;
const MONICA_RE = /\bmonica\b/i;
const PACKAGE_RE =
  /\b(package|parcel|deliver|delivery|mail|food|groceries|maintenance|repair|leak|noise|question|billing|elevator|amenity|hoa|garage|parking)\b/i;
const VISITOR_RE =
  /\b(visitor|guest|here to see|here for|is here|coming up|send (him|her|them) up|has arrived|arrived|lobby|front desk|downstairs|to visit|stopping by|wants? to (come|go) up|let (him|her|them) (up|in))\b|\bha(?:ve|s)\b.*\bhere\b/i;
/** Permission / access questions about a named guest (answered from guest_info). */
const PERMISSION_TOPIC_RE =
  /\b(allowed|permission|permitted|access|park|parking|garage|enter|entry|come up|go up|come in|unit|condo|key|fob|elevator|amenity)\b/i;
const QUESTION_SHAPE_RE =
  /\?|^\s*(is|are|can|could|may|does|do|did|has|have)\b/i;
const PRONOUN_GUEST_RE =
  /\b(she|he|they|her|him|them|this (guest|visitor|person)|the (guest|visitor|person))\b/i;
const CONNECT_INTENT_RE =
  /\b(connect|transfer|put me through|put us through|speak (to|with)|talk (to|with)|get (scott|monica|them|him|her) on|call (scott|monica))\b/i;

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

const TRAILING_CLAUSE_RE =
  /\s*[,.]?\s*(?:is|are|was|were|can|could|should|will|would|do|does|did|may|allowed|ok|okay|please|thanks|thank you)\b.*$/i;

// Words that can never be a visitor's name (STT phrasing debris — a real call
// once captured "here" as the name and wrongly denied the guest).
const NON_NAME_RE =
  /^(a|an|the|for|to|is|it|someone|somebody|here|there|them|him|her|she|he|they|his|hers|their|theirs|you|visitor|guest|waiting|lobby)$/i;

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

const QUESTION_NAME_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(?:is|are|was|were|can|could|may|does|do|did|has|have)\\s+(${NAME})\\s+(?:allowed|permitted|able|authorized|welcome|ok|okay|cleared|have|get|use|park|enter|access)`,
    "i"
  ),
  new RegExp(`\\b(?:does|can)\\s+(${NAME})\\s+have\\b`, "i"),
  new RegExp(`\\b(${NAME})\\s+(?:allowed|permitted|authorized)\\b`, "i"),
  new RegExp(
    `\\b(?:for|about|regarding)\\s+(${NAME})(?:\\s|$|[.?!,])`,
    "i"
  ),
];

/** Pull a guest name out of a permission-style question. */
export function extractQuestionGuestName(utterance: string): string | null {
  const u = utterance.trim();
  for (const re of QUESTION_NAME_PATTERNS) {
    const name = plausibleName(cleanSpokenName(u.match(re)?.[1] ?? ""));
    if (name) return name;
  }
  return null;
}

export function looksLikeGuestPermissionQuestion(utterance: string): boolean {
  const u = utterance.trim();
  if (!u) return false;
  const hasPermissionShape =
    QUESTION_SHAPE_RE.test(u) || PERMISSION_TOPIC_RE.test(u);
  if (!hasPermissionShape) return false;
  // Pure visitor arrivals stay on the admit path — unless this is clearly a
  // permission/access question. "downstairs" alone is in VISITOR_RE and must
  // not steal "Can she park downstairs?" away from Guest Info follow-ups.
  if (
    VISITOR_RE.test(u) &&
    !PACKAGE_RE.test(u) &&
    !PERMISSION_TOPIC_RE.test(u) &&
    !PRONOUN_GUEST_RE.test(u)
  ) {
    return false;
  }
  return true;
}

function truncateNotes(info: string, max = 120): string {
  const t = info.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function asActiveGuest(g: GuestNameRow | ActiveGuest): ActiveGuest {
  return { id: g.id, name: g.name, guest_info: g.guest_info };
}

function withGuest(state: CallState | undefined, guest?: ActiveGuest): CallState {
  return {
    phase: "INTENT",
    activeGuest: guest ?? state?.activeGuest,
    guestSnapshot: state?.guestSnapshot,
  };
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

function availability(deps: CallflowDeps): { scott: boolean; monica: boolean } {
  return deps.transferAvailable ?? { scott: true, monica: true };
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

/** Verbal close without ending the call — the human hangs up. */
function softClose(state: CallState | undefined): CallflowResult {
  return {
    reply: "Okay — thank you! I'm here if you need anything else.",
    nextState: withGuest(state),
    effects: [],
  };
}

function generalTransfer(
  target: TransferTarget,
  state?: CallState
): CallflowResult {
  return {
    reply: `Of course — connecting you to ${targetName(target)} now.`,
    nextState: { phase: "DONE", activeGuest: state?.activeGuest },
    action: "transfer",
    transferTarget: target,
    effects: [{ type: "outcome", outcome: "transfer_attempted" }],
  };
}

function offerConnect(
  spokenLead: string,
  state: CallState | undefined,
  guest?: ActiveGuest
): CallflowResult {
  return {
    reply: `${spokenLead} Would you like me to connect you to Scott or Monica?`,
    nextState: {
      phase: "OFFER_TRANSFER",
      activeGuest: guest ?? state?.activeGuest,
      guestSnapshot: state?.guestSnapshot,
    },
    lookupPending: true,
    effects: [],
  };
}

/** Transfer only when the target has a configured number; never silently remap. */
export function transferIfAvailable(
  target: TransferTarget,
  deps: CallflowDeps,
  state?: CallState
): CallflowResult {
  const avail = availability(deps);
  if (target === "monica" && !avail.monica) {
    return {
      reply:
        "I don't have a transfer number configured for Monica. I can connect you to Scott instead — would you like that?",
      nextState: {
        phase: "OFFER_TRANSFER",
        activeGuest: state?.activeGuest,
        guestSnapshot: state?.guestSnapshot,
      },
      effects: [
        {
          type: "notify",
          event: "system.error",
          message:
            "MONICA_PHONE is missing or empty — refused Monica transfer (not remapped to Scott)",
        },
      ],
    };
  }
  if (target === "scott" && !avail.scott) {
    return {
      reply:
        "I'm sorry — I can't place a transfer right now. Is there anything else I can help with?",
      nextState: withGuest(state),
      effects: [
        {
          type: "notify",
          event: "system.error",
          message: "SCOTT_PHONE is missing or empty — cannot transfer",
        },
      ],
    };
  }
  return generalTransfer(target, state);
}

/** Explicit "connect me to Scott/Monica" — not an approval or hangup. */
export function detectExplicitTransfer(utterance: string): TransferTarget | "ask" | null {
  const u = utterance.trim();
  if (!u) return null;
  const wantsConnect =
    CONNECT_INTENT_RE.test(u) ||
    /\b(still )?(be )?connected\b/i.test(u) ||
    /\b(get|have) (scott|monica) (on the line|please)\b/i.test(u);
  if (!wantsConnect) return null;
  const scott = SCOTT_RE.test(u);
  const monica = MONICA_RE.test(u);
  if (scott && !monica) return "scott";
  if (monica && !scott) return "monica";
  if (scott && monica) return "ask";
  return "ask";
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
    const notes = result.match.guest_info?.trim();
    const notesSuffix = notes ? ` — notes: ${truncateNotes(notes)}` : "";
    const active = asActiveGuest(result.match);
    // Do NOT hang up — the concierge often has follow-up questions.
    return {
      reply: `Yes — ${result.match.name} is expected. It's okay to send them up. Anything else I can help with?`,
      nextState: withGuest(opts.state, active),
      lookupPending: true,
      effects: [
        {
          type: "notify",
          event: "guest.admitted",
          message: `Guest = ${result.match.name} has been let into the building${notesSuffix}`,
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
      nextState: { phase: "ASK_NAME", activeGuest: opts.state?.activeGuest },
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
        activeGuest: opts.state?.activeGuest,
      },
      lookupPending: true,
      effects: [],
    };
  }
  // No-match: keep immediate transfer (fail-closed building access).
  return {
    reply:
      "I don't see them on the approved list. Connecting you to Scott or Monica now.",
    nextState: { phase: "DONE", activeGuest: opts.state?.activeGuest },
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

/**
 * Answer a permission/access question from guest_info for a named or
 * previously identified (active) guest. On unclear / empty notes / model
 * failure → offer Scott/Monica (do not transfer immediately).
 */
async function tryGuestInfoAnswer(
  utterance: string,
  deps: CallflowDeps,
  state?: CallState
): Promise<CallflowResult | null> {
  if (!looksLikeGuestPermissionQuestion(utterance)) return null;

  let guest: ActiveGuest | null = null;
  const spokenName = extractQuestionGuestName(utterance);
  if (spokenName) {
    try {
      const matched = await deps.matchGuest(spokenName);
      if (matched.match) guest = asActiveGuest(matched.match);
      else return null; // named someone not on the active list → not notes Q&A
    } catch {
      return offerConnect(
        "I'm having trouble checking the guest notes.",
        state
      );
    }
  } else if (
    state?.activeGuest &&
    (PRONOUN_GUEST_RE.test(utterance) || PERMISSION_TOPIC_RE.test(utterance))
  ) {
    guest = state.activeGuest;
  } else {
    return null;
  }

  const info = guest.guest_info?.trim() ?? "";
  if (!info) {
    return offerConnect(
      `I'm not sure — I don't have notes that cover that for ${guest.name}.`,
      state,
      guest
    );
  }

  if (!deps.answerGuestInfo) {
    return offerConnect(
      `I'm not sure about that for ${guest.name}.`,
      state,
      guest
    );
  }

  let qa: GuestInfoQaResult | null;
  try {
    qa = await deps.answerGuestInfo({
      guestName: guest.name,
      guestInfo: info,
      question: utterance,
    });
  } catch {
    return offerConnect(
      `I'm not sure — I couldn't check the notes for ${guest.name}.`,
      state,
      guest
    );
  }

  if (!qa || qa.answer === "unclear" || !qa.reply.trim()) {
    return offerConnect(
      `I'm not sure based on the notes for ${guest.name}.`,
      state,
      guest
    );
  }

  return {
    reply: `${qa.reply.trim()} Anything else?`,
    nextState: withGuest(state, guest),
    lookupPending: true,
    effects: [
      {
        type: "notify",
        event: "guest.info_answered",
        message: `${guest.name}: Q="${utterance}" → ${qa.answer}. ${qa.reply.trim()}`,
      },
    ],
  };
}

async function handleOfferTransfer(
  utterance: string,
  deps: CallflowDeps,
  state: CallState
): Promise<CallflowResult> {
  const u = utterance.trim();
  if (GOODBYE_RE.test(u)) return softClose(state);

  if (NO_RE.test(u) && !CONNECT_INTENT_RE.test(u) && !SCOTT_RE.test(u) && !MONICA_RE.test(u)) {
    return {
      reply: "No problem — anything else I can help with?",
      nextState: withGuest(state),
      effects: [],
    };
  }

  if (MONICA_RE.test(u) && !SCOTT_RE.test(u)) {
    return transferIfAvailable("monica", deps, state);
  }
  if (SCOTT_RE.test(u) && !MONICA_RE.test(u)) {
    return transferIfAvailable("scott", deps, state);
  }
  if (SCOTT_RE.test(u) && MONICA_RE.test(u)) {
    return {
      reply: "Who would you like — Scott or Monica?",
      nextState: {
        phase: "OFFER_TRANSFER",
        activeGuest: state.activeGuest,
        guestSnapshot: state.guestSnapshot,
      },
      effects: [],
    };
  }

  if (YES_RE.test(u)) {
    return {
      reply: "Who would you like — Scott or Monica?",
      nextState: {
        phase: "OFFER_TRANSFER",
        activeGuest: state.activeGuest,
        guestSnapshot: state.guestSnapshot,
      },
      effects: [],
    };
  }

  // Continued question / other intent while an offer is pending.
  return handleIntent(u, deps, { ...state, phase: "INTENT" });
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
        nextState: {
          phase: "INTENT",
          clarifies: clarifies + 1,
          activeGuest: state?.activeGuest,
        },
        effects: [],
      };
    }
    return offerConnect("I didn't catch that.", state);
  }

  // Explicit connection requests are never mistaken for approval or hangup.
  const explicit = detectExplicitTransfer(utterance);
  if (explicit === "ask") {
    return {
      reply: "Who would you like — Scott or Monica?",
      nextState: {
        phase: "OFFER_TRANSFER",
        activeGuest: state?.activeGuest,
        guestSnapshot: state?.guestSnapshot,
      },
      effects: [],
    };
  }
  if (explicit === "scott" || explicit === "monica") {
    return transferIfAvailable(explicit, deps, state);
  }

  // Visitor arrivals with an extractable name take priority over Guest Info
  // Q&A (e.g. "…Her name is Sarah Connor. Is she allowed to come up?").
  if (VISITOR_RE.test(utterance) && !PACKAGE_RE.test(utterance)) {
    const name = extractName(utterance);
    if (name) {
      return matchAndRespond(name, deps, { denyOnMiss: false, state });
    }
    // No name yet: ask for it unless this is a pronoun/permission follow-up
    // about a guest we already identified on this call.
    if (!(state?.activeGuest && looksLikeGuestPermissionQuestion(utterance))) {
      return {
        reply: "Of course — what's the visitor's name?",
        nextState: { phase: "ASK_NAME", activeGuest: state?.activeGuest },
        effects: [],
      };
    }
  }

  // Permission / access follow-ups (incl. "Can she park downstairs?").
  const fromNotes = await tryGuestInfoAnswer(utterance, deps, state);
  if (fromNotes) return fromNotes;

  // Generic "is Monica available?" without connect verbs still routes to Monica.
  if (MONICA_RE.test(utterance) && !SCOTT_RE.test(utterance)) {
    return transferIfAvailable("monica", deps, state);
  }

  return transferIfAvailable("scott", deps, state);
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
      const inner = await handleIntent(utterance, deps, state);
      return { ...inner, effects: [started, ...inner.effects] };
    }

    case "INTENT": {
      if (GOODBYE_RE.test(utterance) || DONE_RE.test(utterance)) {
        // Soft close — do not send hangup; the human ends the call.
        return softClose(state);
      }
      if (GREETING_ONLY_RE.test(utterance)) {
        return {
          reply: "What's up?",
          nextState: withGuest(state),
          effects: [],
        };
      }
      return handleIntent(utterance, deps, state);
    }

    case "ASK_NAME": {
      if (GOODBYE_RE.test(utterance)) return softClose(state);
      const name = plausibleName(cleanSpokenName(utterance));
      if (!name) {
        const clarifies = state.clarifies ?? 0;
        if (clarifies < 2) {
          return {
            reply: state.askedFullName
              ? "Sorry — could I get the first and last name?"
              : "Sorry — what was the visitor's name?",
            nextState: {
              ...state,
              clarifies: clarifies + 1,
            },
            effects: [],
          };
        }
        return offerConnect("I still didn't catch the name.", state);
      }
      return matchAndRespond(name, deps, {
        denyOnMiss: true,
        allowPartialReask: !state.askedFullName,
        state,
      });
    }

    case "OFFER_TRANSFER":
      return handleOfferTransfer(utterance, deps, state);

    case "HOLDING": {
      // Legacy ack-hold phase — transfers are immediate now.
      return transferIfAvailable("scott", deps, state);
    }

    case "TAKE_MESSAGE": {
      if (!utterance || DONE_RE.test(utterance) || GOODBYE_RE.test(utterance)) {
        return {
          reply:
            "No problem — I'll let Scott and Monica know you called. Thank you! Goodbye.",
          nextState: { phase: "DONE", activeGuest: state.activeGuest },
          // Message-taking end of a failed-transfer path may hang up.
          action: "hangup",
          effects: [],
        };
      }
      return {
        reply: "Got it. Anything else?",
        nextState: {
          phase: "CONFIRM_MESSAGE",
          messageParts: [...(state.messageParts ?? []), utterance],
          activeGuest: state.activeGuest,
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
          nextState: { phase: "DONE", activeGuest: state.activeGuest },
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
          activeGuest: state.activeGuest,
        },
        effects: [],
      };
    }

    case "DONE":
      // Stay soft — if the call somehow continues, don't force another hangup.
      return softClose(state);
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
    nextState: {
      phase: "TAKE_MESSAGE",
      messageParts: [],
      activeGuest: prev.nextState.activeGuest,
    },
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
