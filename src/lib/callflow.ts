import type { GuestMatch, GuestNameRow } from "./db/guests";
import type { NotifyEvent } from "./notify";
import {
  classifyDeskSubject,
  clarifySubjectPrompt,
  isWholeTurnHold,
  namesReferToSameGuest,
  stripHoldLead,
  type DeskSubject,
} from "./desksubject";

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
  | "CLARIFY_SUBJECT"
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
  /**
   * Last identified guest on this call — used for pronoun follow-ups.
   * `null` = intentional clear (e.g. new unnamed visitor); omit/`undefined` =
   * leave unchanged for the persistence layer to carry forward.
   */
  activeGuest?: ActiveGuest | null;
  /** True after a failed-transfer message was saved+notified once. */
  messageSaved?: boolean;
  /**
   * Ambiguous desk utterance held while we ask whether it is about
   * `activeGuest` or someone new. Cleared when the subject is resolved.
   */
  pendingUtterance?: string;
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
  answer: "yes" | "no" | "unclear" | "answered";
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
// Longer alternatives first — otherwise `\bno\b` eats "No thanks" / "No thank you".
const DONE_RE =
  /^\s*(no thank you|no thanks?|thank you|thanks|nothing else|nothing|nope|that(’|'| i)?s (it|all|everything)|no)\b/i;
/** Lead-only match for DONE_RE — strips the done phrase so a continued clause remains. */
const DONE_LEAD_RE =
  /^\s*(no thank you|no thanks?|thank you|thanks|nothing else|nothing|nope|that(?:’|'| i)?s (?:it|all|everything)|no)\b/i;
const YES_RE =
  /^\s*(yes|yeah|yep|yup|sure|please|ok|okay|go ahead|do it|connect (me|us)?)\b/i;
/** Whole-turn affirmatives only — "Please tell her…" must not count as offer consent. */
const SHORT_YES_RE =
  /^\s*(?:yes|yeah|yep|yup|sure|please|ok|okay|go ahead|do it|connect (?:me|us)?)(?:[,.\s]+(?:yes|yeah|yep|yup|sure|please|ok|okay|go ahead|do it))*[.!,?\s]*$/i;
// Bare "don't"/"do not" are NOT declines — those may be guest instructions
// ("don't let her use the garage"). Transfer refusals use hasTransferNegation.
const NO_RE =
  /^\s*(no|nope|nah|no thank you|no thanks?|not now|never ?mind)\b/i;
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
/** Factual / instruction follow-ups answered from Guest Info (not only access). */
const FACTUAL_FOLLOWUP_RE =
  /\b(what time|expected|arriv(?:e|ing|al)|tell (her|him|them)|special instructions?|instructions?|where (should|to|do)|delivery|deliver|leave (it|the|a)|package for|notes?|anything (i should|else)|who (is|are) (she|he|they)|purpose|here for)\b/i;
const TRANSFER_NEGATION_RE =
  /\b((do\s*n[o’']?t|does\s*n[o’']?t|did\s*n[o’']?t|never)\b.{0,40}\b(connect|transfer|put me|put us|call|ring)\b|\bno\b[,.]?\s+(thanks?|thank you)?[,.]?\s*((do\s*n[o’']?t|does\s*n[o’']?t)\s+)?(connect|transfer|put)|(?:don'?t|do not)\s+(connect|transfer)\s+me\s+to\s+(scott|monica)|no[,.]?.{0,24}(connect|transfer).{0,16}(scott|monica))/i;

// Name tokens only — no periods/location/stop words — so
// "Sarah Connor. Is she allowed…" and "John Smith here in the lobby" stay clean.
// Stop words prevent "guest is in the lobby" from capturing "in the" as a name.
// guest/visitor stay allowed as later name tokens ("Test Visitor") but
// plausibleName rejects names that *start* with those words.
// Trailing \b is required: case-insensitive patterns otherwise treat short
// stop words as prefixes and reject real names (Ann, Helen, Theodore).
const NAME_PART =
  "(?!(?:here|there|waiting|downstairs|lobby|named|called|in|the|a|an|to|for|at|of|with|and|or|from|on|by|my|our|your|this|that|they|them|she|he|her|his|him|their)\\b)[A-Za-z][A-Za-z'’-]*";
const NAME = `${NAME_PART}(?:\\s+${NAME_PART}){0,3}`;
const NAME_PATTERNS: RegExp[] = [
  new RegExp(
    `(?:i (?:also )?have|i've got|we have|there is|there's)\\s+(?:an?\\s+)?(?:visitor|guest)?\\s*(?:named|called|name is)?\\s*(${NAME})\\s+(?:here|in the lobby|at the front desk|at the door|downstairs|for you|to see|waiting)`,
    "i"
  ),
  // Require named/called/name is — bare "guest is …" is deixis, not a name cue.
  new RegExp(
    `(?:visitor|guest)\\s+(?:named|called|name is)\\s+(?:an?\\s+|the\\s+)?(${NAME})\\b`,
    "i"
  ),
  new RegExp(
    `(?:it is|it's|this is|named|called|name is)\\s+(?:an?\\s+|the\\s+)?(${NAME})\\b`,
    "i"
  ),
  new RegExp(
    `^(${NAME})\\s+is\\s+(?:here|in the lobby|at the front desk|at the door|downstairs|waiting|outside)`,
    "i"
  ),
  // Mid-utterance: "Sarah Connor is at the door, can she come up?"
  new RegExp(
    `\\b(${NAME})\\s+is\\s+(?:here|in the lobby|at the front desk|at the door|downstairs|waiting|outside)\\b`,
    "i"
  ),
];

// Require a word boundary before the verb so "his visitor" is not stripped to "h".
const TRAILING_CLAUSE_RE =
  /\s*[,.]?\s*\b(?:is|are|was|were|can|could|should|will|would|do|does|did|may|allowed|ok|okay|please|thanks|thank you)\b.*$/i;

// Words that can never be a visitor's name (STT phrasing debris — a real call
// once captured "here" as the name and wrongly denied the guest).
const NON_NAME_RE =
  /^(a|an|the|for|to|is|it|someone|somebody|another|other|different|here|there|them|him|her|she|he|they|his|hers|their|theirs|you|visitor|guest|waiting|lobby|time|unit|condo|garage|parking|package|delivery|instructions?|notes?|anything|something|scott|monica)$/i;

function plausibleName(candidate: string | undefined): string | null {
  const c = candidate?.trim().replace(/^(an?|the)\s+/i, "");
  if (!c) return null;
  if (NON_NAME_RE.test(c)) return null; // exact filler words ("here", "visitor", …)
  // location/delivery phrases are never names, but a name may CONTAIN a filler
  // word (the acceptance-test guest is literally called "Test Visitor")
  if (/\b(front desk|lobby|package|delivery)\b/i.test(c)) return null;
  if (/^(visitor|guest)\b/i.test(c)) return null; // "visitor John" is phrasing debris
  // Deictic "our/my/your guest" is never a person name.
  if (/^(my|our|your|this|that)\s+(guest|visitor)\b/i.test(c)) return null;
  // "another guest" / "someone else" captured by NAME patterns are not people.
  // Do not reject real names that merely start with Other (fixture: "Other Person").
  if (/^(another|someone|somebody)\b/i.test(c)) return null;
  if (/\b(another|someone|somebody|other|different)\s+(guest|visitor)\b/i.test(c)) {
    return null;
  }
  // Role / demographic labels are never visitor names.
  if (
    /^(man|woman|guy|lady|gentleman|person|courier|driver|female|male|housekeeper|cleaner)(\s|$)/i.test(
      c
    ) ||
    /^(female|male)\s+(visitor|guest)\b/i.test(c) ||
    /^delivery(\s+person)?\b/i.test(c)
  ) {
    return null;
  }
  // Reject multi-token captures that are mostly stop words ("in the").
  const parts = c.split(/\s+/);
  if (
    parts.every((p) =>
      /^(a|an|the|in|to|for|at|of|with|and|or|from|on|by|my|our|your|this|that)$/i.test(
        p
      )
    )
  ) {
    return null;
  }
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
    `\\b(?:is|are|was|were|can|could|may|does|do|did|has|have)\\s+(${NAME})\\s+(?:allowed|permitted|able|authorized|welcome|ok|okay|cleared|have|get|use|park|enter|access|any|special|expected)`,
    "i"
  ),
  new RegExp(`\\b(?:does|can)\\s+(${NAME})\\s+have\\b`, "i"),
  new RegExp(`\\b(${NAME})\\s+(?:allowed|permitted|authorized|expected)\\b`, "i"),
  new RegExp(
    `\\b(?:for|about|regarding)\\s+(${NAME})(?:\\s|$|[.?!,])`,
    "i"
  ),
  new RegExp(
    `\\b(?:what time|when|where)\\s+(?:is|should|does|do|can)\\s+(${NAME})\\b`,
    "i"
  ),
  new RegExp(
    `\\b(?:what|how)\\s+(?:should I|do I|to)\\s+(?:tell|leave|give)\\s+(?:for\\s+)?(${NAME})\\b`,
    "i"
  ),
];

/** Guest-name candidates from questions — reject STT/grammar filler tokens. */
function plausibleQuestionGuestName(candidate: string | undefined): string | null {
  const name = plausibleName(candidate);
  if (!name) return null;
  const parts = name.split(/\s+/);
  // Reject STT/grammar debris ("question about", "parking", …) so we fall
  // through to activeGuest instead of treating filler as a missing guest.
  if (
    parts.some((p) =>
      /^(what|when|where|how|who|why|is|are|was|were|she|he|they|her|him|them|his|hers|their|this|that|time|unit|condo|garage|parking|package|delivery|instructions?|notes?|question|about|regarding|also|pass|one|more|still|just|please|thanks?|scott|monica|use|access|visitor|guest|female|male|man|woman|person|tell|leave|give)$/i.test(
        p
      )
    )
  ) {
    return null;
  }
  return name;
}

/** Pull a guest name out of a Guest Info follow-up question. */
export function extractQuestionGuestName(utterance: string): string | null {
  const u = utterance.trim();
  for (const re of QUESTION_NAME_PATTERNS) {
    const name = plausibleQuestionGuestName(cleanSpokenName(u.match(re)?.[1] ?? ""));
    if (name) return name;
  }
  return null;
}

/** @deprecated Use looksLikeGuestInfoFollowUp — kept as alias for older tests. */
export function looksLikeGuestPermissionQuestion(utterance: string): boolean {
  return looksLikeGuestInfoFollowUp(utterance, undefined);
}

/** Spoken name candidates for desk-subject classification. */
function spokenDeskName(utterance: string): string | null {
  return extractName(utterance) || extractQuestionGuestName(utterance);
}

/** Three-way desk subject: same guest / new arrival / clarify / unrelated. */
export function deskSubjectFor(
  utterance: string,
  state?: CallState
): DeskSubject {
  return classifyDeskSubject(utterance, state?.activeGuest, {
    spokenName: spokenDeskName(utterance),
  });
}

/**
 * Fresh visitor announcement (possibly different/unnamed) — must not reuse a
 * prior activeGuest's notes for access answers. Same-guest pronoun / lobby
 * status / clarify-needed turns return false (clarify is handled separately).
 */
export function looksLikeNewVisitorAnnouncement(
  utterance: string,
  state?: CallState
): boolean {
  return deskSubjectFor(utterance, state).kind === "new_arrival";
}

/**
 * Whether this utterance should be answered from Guest Info notes (permissions
 * OR factual/instruction follow-ups), rather than an unsolicited transfer.
 */
export function looksLikeGuestInfoFollowUp(
  utterance: string,
  state?: CallState
): boolean {
  const u = utterance.trim();
  if (!u) return false;

  // Security / continuity: never answer from prior notes for a new arrival or
  // an ambiguous subject — those routes ask for a name or clarify first.
  const subject = deskSubjectFor(u, state);
  if (subject.kind === "new_arrival" || subject.kind === "clarify") {
    return false;
  }

  // Fail-closed: with an active guest, unrelated turns that still mention an
  // indefinite/unnamed person must not fall through to Guest Info notes.
  if (
    state?.activeGuest &&
    subject.kind === "unrelated" &&
    (/\b(?:someone|somebody)\b/i.test(u) ||
      (/\b(?:visitor|guest)\b/i.test(u) &&
        !/\b(?:the|this|that|my|our|his|her|their)\s+(?:guest|visitor)\b/i.test(
          u
        ) &&
        !/\bvisitor\s+(?:parking|pass|spot|space|permit|sticker|badge)\b/i.test(
          u
        )))
  ) {
    return false;
  }

  const hasGuestContext =
    Boolean(state?.activeGuest) || Boolean(extractQuestionGuestName(u));
  const infoSeeking =
    /\?/.test(u) ||
    QUESTION_SHAPE_RE.test(u) ||
    PERMISSION_TOPIC_RE.test(u) ||
    FACTUAL_FOLLOWUP_RE.test(u) ||
    PRONOUN_GUEST_RE.test(u);

  if (!infoSeeking) return false;

  // Pure visitor arrivals ("I have a guest here") stay on the admit path.
  if (
    VISITOR_RE.test(u) &&
    !PACKAGE_RE.test(u) &&
    !PERMISSION_TOPIC_RE.test(u) &&
    !FACTUAL_FOLLOWUP_RE.test(u) &&
    !PRONOUN_GUEST_RE.test(u) &&
    !extractQuestionGuestName(u)
  ) {
    return false;
  }

  // With an identified guest (this turn or earlier), any info-seeking follow-up
  // goes to notes — the model returns unclear if notes don't cover it.
  // Without a guest name/activeGuest, do NOT treat generic unit/parking chatter
  // as Guest Info (that would swallow "Is Monica available? … unit" transfers).
  return hasGuestContext;
}

/** True when the speaker is declining / negating a transfer. */
export function hasTransferNegation(utterance: string): boolean {
  return TRANSFER_NEGATION_RE.test(utterance.trim());
}

/**
 * True only when the utterance is a bare done/no-thanks close.
 * "No thanks, can she still use the garage?" is NOT done — the question remains.
 */
export function isPureDoneUtterance(utterance: string): boolean {
  const u = utterance.trim();
  if (!u || !DONE_RE.test(u)) return false;
  const remainder = u.replace(DONE_LEAD_RE, "").replace(/^[,.\s]+/, "").trim();
  return remainder.length === 0;
}

/** True for bare goodbyes, pure done/no-thanks, or whole-turn hold idioms. */
function isSoftCloseUtterance(utterance: string): boolean {
  const u = utterance.trim();
  return (
    GOODBYE_RE.test(u) || isPureDoneUtterance(u) || isWholeTurnHold(u)
  );
}

/** Ask which person a desk turn is about — never guess from prior notes. */
function clarifyActiveGuest(
  state: CallState | undefined,
  pendingUtterance: string
): CallflowResult {
  const guest = state?.activeGuest;
  if (!guest) {
    return {
      reply: "Of course — what's the visitor's name?",
      nextState: {
        phase: "ASK_NAME",
        activeGuest: null,
        guestSnapshot: state?.guestSnapshot,
        messageSaved: state?.messageSaved,
      },
      effects: [],
    };
  }
  return {
    reply: clarifySubjectPrompt(guest.name),
    nextState: {
      phase: "CLARIFY_SUBJECT",
      activeGuest: guest,
      guestSnapshot: state?.guestSnapshot,
      messageSaved: state?.messageSaved,
      pendingUtterance,
      clarifies: 0,
    },
    effects: [],
  };
}

/** Role / demographic labels STT may capture instead of a real person name. */
function isRoleOrDebrisName(name: string | null | undefined): boolean {
  if (!name) return true;
  return /^(man|woman|guy|lady|gentleman|person|visitor|guest|courier|driver|delivery(\s+person)?|female(\s+visitor)?|male(\s+visitor)?|someone|somebody|access|parking|pass|use|her|him|them|his|hers|their)$/i.test(
    name.trim()
  );
}

/** Route a high-confidence new arrival: match a name or ask for one. */
async function handleNewArrival(
  utterance: string,
  deps: CallflowDeps,
  state: CallState | undefined,
  named: string | null
): Promise<CallflowResult> {
  const raw = named || extractName(utterance);
  const name = isRoleOrDebrisName(raw) ? null : raw;
  // Always clear prior guest identity for a new arrival (security).
  const clearedState: CallState = {
    phase: "INTENT",
    activeGuest: null,
    guestSnapshot: state?.guestSnapshot,
    messageSaved: state?.messageSaved,
  };
  if (name) {
    return matchAndRespond(name, deps, {
      denyOnMiss: false,
      state: clearedState,
    });
  }
  return {
    reply: "Of course — what's the visitor's name?",
    nextState: {
      phase: "ASK_NAME",
      // Explicit null clear — must survive webhook persistence (not `??` prior).
      activeGuest: null,
      guestSnapshot: state?.guestSnapshot,
      messageSaved: state?.messageSaved,
    },
    effects: [],
  };
}

function truncateNotes(info: string, max = 120): string {
  const t = info.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function asActiveGuest(g: GuestNameRow | ActiveGuest): ActiveGuest {
  return { id: g.id, name: g.name, guest_info: g.guest_info };
}

function withGuest(
  state: CallState | undefined,
  guest?: ActiveGuest | null
): CallState {
  // Preserve explicit null clears; only fall back when guest arg is omitted.
  const activeGuest =
    guest !== undefined ? guest : (state?.activeGuest ?? undefined);
  return {
    phase: "INTENT",
    ...(activeGuest !== undefined ? { activeGuest } : {}),
    guestSnapshot: state?.guestSnapshot,
    messageSaved: state?.messageSaved,
    // Subject ambiguity is resolved once we leave CLARIFY_SUBJECT.
    pendingUtterance: undefined,
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
  // Negated requests are never consent to connect.
  if (hasTransferNegation(u)) return null;
  const isQuestion = /\?/.test(u) || QUESTION_SHAPE_RE.test(u);
  const namesResident = SCOTT_RE.test(u) || MONICA_RE.test(u);
  // Questions without a named resident are transfers only for first-person
  // connect requests. Guest follow-ups ("Can she connect to wifi?", "Can she
  // talk to them?") must not steal the turn into "who to connect?".
  if (isQuestion && !namesResident) {
    const firstPersonConnect =
      /\b((connect|transfer) (me|us)|put (me|us) through)\b/i.test(u) ||
      /\b(can|could|may) (i|we)\b.{0,48}\b(connect|transfer|connected|put (me|us))\b/i.test(
        u
      );
    if (!firstPersonConnect) return null;
  }
  // Questions about a resident ("Did Monica leave instructions?") are not transfers.
  if (
    isQuestion &&
    !CONNECT_INTENT_RE.test(u) &&
    !/\b(still )?(be )?connected\b/i.test(u)
  ) {
    return null;
  }
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

/**
 * In OFFER_TRANSFER, detect a clear target selection — not a continued question
 * or a mere mention of a resident's name.
 */
export function detectOfferSelection(utterance: string): TransferTarget | "ask" | null {
  const u = utterance.trim();
  if (!u) return null;
  if (hasTransferNegation(u)) return null;
  // Continued questions are not selections.
  if (
    /\?/.test(u) ||
    /^(did|does|do|is|are|was|were|what|when|where|how|can|could|should|may)\b/i.test(
      u
    )
  ) {
    return null;
  }
  const scott = SCOTT_RE.test(u);
  const monica = MONICA_RE.test(u);
  // Bare name or short affirmative pick: "Scott", "Monica please", "Yes, Scott"
  // Leading please/ok alone is not consent when more instruction follows
  // ("Please tell her to use the elevator").
  if (/^\s*(yes|yeah|yep|sure|ok|okay)[,.]?\s+/i.test(u) || YES_RE.test(u)) {
    if (scott && !monica) return "scott";
    if (monica && !scott) return "monica";
    if (!scott && !monica) return SHORT_YES_RE.test(u) ? "ask" : null;
    return "ask";
  }
  if (/^\s*scott\b/i.test(u) && !monica) return "scott";
  if (/^\s*monica\b/i.test(u) && !scott) return "monica";
  // "Connect me to Scott" while offer pending
  return detectExplicitTransfer(u);
}

/** Strip a leading decline so a continued question can be handled. */
export function stripDeclineLead(utterance: string): string {
  return utterance
    .trim()
    .replace(
      /^\s*(no thank you|no thanks?|nope|nah|not now|never ?mind|no)[,.]?\s*/i,
      ""
    )
    .replace(
      /^\s*((do\s*n[o’']?t|does\s*n[o’']?t|did\s*n[o’']?t|never)\s+(connect|transfer|put me through|put us through|call|ring)\b[^.?!,]*)[,.]?\s*/i,
      ""
    )
    .replace(
      /^\s*no[,.]?\s+(thanks?|thank you)?[,.]?\s*((do\s*n[o’']?t|does\s*n[o’']?t)\s+)?(connect|transfer)\b[^.?!,]*/i,
      ""
    )
    .trim();
}

/**
 * Acknowledge a transfer refusal. Never transfer. If a continued guest
 * question (or other intent) remains after stripping the decline, handle it.
 */
async function handleTransferDecline(
  utterance: string,
  deps: CallflowDeps,
  state?: CallState
): Promise<CallflowResult> {
  const remainder = stripDeclineLead(utterance);
  if (
    remainder &&
    remainder.toLowerCase() !== utterance.trim().toLowerCase() &&
    !hasTransferNegation(remainder) &&
    (looksLikeGuestInfoFollowUp(remainder, state) ||
      detectExplicitTransfer(remainder) ||
      VISITOR_RE.test(remainder) ||
      PACKAGE_RE.test(remainder))
  ) {
    return handleIntent(remainder, deps, {
      phase: "INTENT",
      activeGuest: state?.activeGuest,
      guestSnapshot: state?.guestSnapshot,
      messageSaved: state?.messageSaved,
    });
  }
  return {
    reply: "No problem — anything else I can help with?",
    nextState: withGuest(state),
    effects: [],
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
 *
 * `forceSameGuest` skips desk-subject classification — used after the desk
 * explicitly confirms the turn is about `activeGuest`.
 */
async function tryGuestInfoAnswer(
  utterance: string,
  deps: CallflowDeps,
  state?: CallState,
  opts: { forceSameGuest?: boolean } = {}
): Promise<CallflowResult | null> {
  if (!opts.forceSameGuest && !looksLikeGuestInfoFollowUp(utterance, state)) {
    return null;
  }
  if (opts.forceSameGuest && !state?.activeGuest) return null;

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
  } else if (state?.activeGuest) {
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
  if (isSoftCloseUtterance(u)) return softClose(state);

  // Decline / negation — never transfer; peel off a continued question if any.
  if (hasTransferNegation(u) || (NO_RE.test(u) && !detectOfferSelection(u))) {
    return handleTransferDecline(u, deps, state);
  }

  const pick = detectOfferSelection(u);
  if (pick === "ask") {
    return {
      reply: "Who would you like — Scott or Monica?",
      nextState: {
        phase: "OFFER_TRANSFER",
        activeGuest: state.activeGuest,
        guestSnapshot: state.guestSnapshot,
        messageSaved: state.messageSaved,
      },
      effects: [],
    };
  }
  if (pick === "scott" || pick === "monica") {
    return transferIfAvailable(pick, deps, state);
  }

  // Continued question / other intent while an offer is pending.
  return handleIntent(u, deps, { ...state, phase: "INTENT" });
}

async function handleIntent(
  utteranceRaw: string,
  deps: CallflowDeps,
  state?: CallState
): Promise<CallflowResult> {
  // "Hold on, can she park?" → keep the question; bare holds soft-close upstream.
  const utterance = stripHoldLead(utteranceRaw) || utteranceRaw.trim();

  if (isIncomplete(utterance)) {
    const clarifies = state?.clarifies ?? 0;
    if (clarifies < 2) {
      return {
        reply: "Sorry — could you say that again?",
        nextState: {
          phase: "INTENT",
          clarifies: clarifies + 1,
          activeGuest: state?.activeGuest,
          messageSaved: state?.messageSaved,
        },
        effects: [],
      };
    }
    return offerConnect("I didn't catch that.", state);
  }

  // Negated connect requests must never fall through to the Scott transfer
  // fallback ("Don't transfer me to Scott" → null explicit → was transferring).
  if (hasTransferNegation(utterance)) {
    return handleTransferDecline(utterance, deps, state);
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
        messageSaved: state?.messageSaved,
      },
      effects: [],
    };
  }
  if (explicit === "scott" || explicit === "monica") {
    return transferIfAvailable(explicit, deps, state);
  }

  // Direct "Is Monica available?" / package-for-Monica — only when this is not
  // a Guest Info question about a guest. Resident mentions inside guest
  // questions ("Did Monica leave instructions?") must not transfer.
  // "Is Monica available?" stays a Monica transfer even with activeGuest set
  // (looksLikeGuestInfoFollowUp is true for any question once a guest is known).
  if (
    MONICA_RE.test(utterance) &&
    !SCOTT_RE.test(utterance) &&
    !hasTransferNegation(utterance) &&
    (/\bis monica available\b/i.test(utterance) ||
      (!looksLikeGuestInfoFollowUp(utterance, state) &&
        (CONNECT_INTENT_RE.test(utterance) ||
          /\b(question|package|delivery|maintenance)\b/i.test(utterance))))
  ) {
    return transferIfAvailable("monica", deps, state);
  }

  // Conservative desk-subject classification:
  // - new_arrival → match/ask name (never invent unnamed permissions)
  // - clarify → ask which person (never reuse prior notes on ambiguity)
  // - same_guest / unrelated → Guest Info or other routing below
  const subject = deskSubjectFor(utterance, state);
  if (subject.kind === "new_arrival") {
    return handleNewArrival(utterance, deps, state, subject.named);
  }
  if (subject.kind === "clarify") {
    return clarifyActiveGuest(state, utterance);
  }

  // Visitor arrivals that didn't trip the classifier (rare) —
  // still prefer match / ask-name over blind transfer when framed as a visitor.
  // If a different name is spoken while a prior guest is active, clear first
  // so a miss cannot leave Jane in place for later "can she…?" notes answers.
  if (VISITOR_RE.test(utterance) && !PACKAGE_RE.test(utterance)) {
    const name = extractName(utterance);
    if (name) {
      const prior = state?.activeGuest;
      const clearPrior =
        prior != null && !namesMatchGuest(name, prior.name);
      return matchAndRespond(name, deps, {
        denyOnMiss: false,
        state: clearPrior
          ? {
              phase: "INTENT",
              activeGuest: null,
              guestSnapshot: state?.guestSnapshot,
              messageSaved: state?.messageSaved,
            }
          : state,
      });
    }
    if (!state?.activeGuest) {
      return {
        reply: "Of course — what's the visitor's name?",
        nextState: {
          phase: "ASK_NAME",
          messageSaved: state?.messageSaved,
        },
        effects: [],
      };
    }
  }

  // Guest Info follow-ups (permissions + factual/instruction questions).
  const fromNotes = await tryGuestInfoAnswer(utterance, deps, state);
  if (fromNotes) return fromNotes;

  return transferIfAvailable("scott", deps, state);
}

async function handleClarifySubject(
  utterance: string,
  deps: CallflowDeps,
  state: CallState
): Promise<CallflowResult> {
  const u = utterance.trim();
  if (isSoftCloseUtterance(u)) return softClose(state);
  if (hasTransferNegation(u)) return handleTransferDecline(u, deps, state);

  const guest = state.activeGuest;
  const guestName = guest?.name ?? "";
  const first =
    guestName.split(/\s+/)[0]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";

  // Rejecting the known guest (or picking "someone new") wins over incidental
  // her/name/yes matches in the same turn ("not her", "yes, someone new").
  const deniesKnownGuest =
    /\b(?:not|isn'?t|is not|ain'?t)\s+(?:her|she|him|them)\b/i.test(u) ||
    /\b(?:not|isn'?t|is not|ain'?t)\s+(?:the|that)\s+(?:guest|visitor)\b/i.test(
      u
    ) ||
    (Boolean(first) &&
      new RegExp(`\\b(?:not|isn'?t|is not|ain'?t)\\s+${first}\\b`, "i").test(u));
  const mentionsNew =
    /\b(?:someone new|somebody new|new (?:guest|visitor|person)|different|another|someone else|somebody else)\b/i.test(
      u
    );

  const aboutSame =
    !deniesKnownGuest &&
    !mentionsNew &&
    (/\b(?:same|her|she|that (?:guest|visitor)|the (?:guest|visitor))\b/i.test(
      u
    ) ||
      (Boolean(first) && new RegExp(`\\b${first}\\b`, "i").test(u)) ||
      /^\s*(yes|yeah|yep|yup|correct|right)\b/i.test(u));

  const aboutNew =
    deniesKnownGuest ||
    mentionsNew ||
    (/^\s*(no|nope|nah)\b/i.test(u) && !aboutSame);

  if (aboutNew) {
    // Always clear prior guest when the desk picks "someone new".
    const clearedState: CallState = {
      phase: "INTENT",
      activeGuest: null,
      guestSnapshot: state.guestSnapshot,
      messageSaved: state.messageSaved,
    };
    // Denial debris ("no it's not her") can look like a spoken name — skip it.
    const name = deniesKnownGuest ? null : extractName(u);
    if (
      name &&
      guest &&
      !namesMatchGuest(name, guest.name) &&
      !isRoleOrDebrisName(name)
    ) {
      return matchAndRespond(name, deps, {
        denyOnMiss: false,
        state: clearedState,
      });
    }
    return {
      reply: "Of course — what's the visitor's name?",
      nextState: {
        phase: "ASK_NAME",
        activeGuest: null,
        guestSnapshot: state.guestSnapshot,
        messageSaved: state.messageSaved,
      },
      effects: [],
    };
  }

  if (aboutSame && guest) {
    const pending = (state.pendingUtterance ?? "").trim();
    // Replay the original ambiguous question against the confirmed guest.
    if (pending) {
      const answered = await tryGuestInfoAnswer(
        pending,
        deps,
        {
          ...state,
          phase: "INTENT",
          activeGuest: guest,
          pendingUtterance: undefined,
        },
        { forceSameGuest: true }
      );
      if (answered) {
        return {
          ...answered,
          nextState: {
            ...answered.nextState,
            pendingUtterance: undefined,
          },
        };
      }
    }
    return {
      reply: `Got it — what do you need to know about ${guest.name}?`,
      nextState: withGuest(
        { ...state, phase: "INTENT", pendingUtterance: undefined },
        guest
      ),
      effects: [],
    };
  }

  // Still unclear — ask once more, then fail closed to name ask.
  const clarifies = state.clarifies ?? 0;
  if (clarifies < 1 && guest) {
    return {
      reply: clarifySubjectPrompt(guest.name),
      nextState: {
        ...state,
        phase: "CLARIFY_SUBJECT",
        clarifies: clarifies + 1,
      },
      effects: [],
    };
  }
  return {
    reply: "Of course — what's the visitor's name?",
    nextState: {
      phase: "ASK_NAME",
      activeGuest: null,
      guestSnapshot: state.guestSnapshot,
      messageSaved: state.messageSaved,
    },
    effects: [],
  };
}

function namesMatchGuest(spoken: string, guestName: string): boolean {
  return namesReferToSameGuest(spoken, guestName);
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
      if (isSoftCloseUtterance(utterance)) {
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
      if (isSoftCloseUtterance(utterance)) {
        return softClose(state);
      }
      // Clear refusal to connect — never treat as a guest name / no-match transfer.
      if (hasTransferNegation(utterance)) {
        return handleTransferDecline(utterance, deps, state);
      }
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

    case "CLARIFY_SUBJECT":
      return handleClarifySubject(utterance, deps, state);

    case "OFFER_TRANSFER":
      return handleOfferTransfer(utterance, deps, state);

    case "HOLDING": {
      // Legacy ack-hold phase — transfers are immediate now, unless refused.
      if (isSoftCloseUtterance(utterance) || hasTransferNegation(utterance)) {
        return handleTransferDecline(utterance, deps, state);
      }
      return transferIfAvailable("scott", deps, state);
    }

    case "TAKE_MESSAGE": {
      if (!utterance || isSoftCloseUtterance(utterance)) {
        // No message body — soft close; human ends the call.
        return {
          reply:
            "No problem — I'll let Scott and Monica know you called. I'm here if you need anything else.",
          nextState: withGuest(state),
          effects: [],
        };
      }
      if (hasTransferNegation(utterance)) {
        const remainder = stripDeclineLead(utterance);
        if (remainder && !hasTransferNegation(remainder)) {
          // Decline + message body in one turn.
          return {
            reply: "Got it. Anything else?",
            nextState: {
              phase: "CONFIRM_MESSAGE",
              messageParts: [...(state.messageParts ?? []), remainder],
              activeGuest: state.activeGuest,
              messageSaved: false,
            },
            effects: [],
          };
        }
        return {
          reply:
            "No problem — go ahead with a message whenever you're ready, or ask anything else.",
          nextState: {
            phase: "TAKE_MESSAGE",
            messageParts: state.messageParts ?? [],
            activeGuest: state.activeGuest,
            messageSaved: state.messageSaved,
          },
          effects: [],
        };
      }
      // Stay in message-taking unless the desk clearly announces a new arrival.
      // Guest-info phrasing and "call Scott" during dictation are message body
      // (often after a failed transfer). CONFIRM_MESSAGE still finalizes then
      // routes real follow-ups.
      if (
        looksLikeNewVisitorAnnouncement(utterance, state) ||
        (VISITOR_RE.test(utterance) && extractName(utterance))
      ) {
        return handleIntent(utterance, deps, {
          ...state,
          phase: "INTENT",
        });
      }
      return {
        reply: "Got it. Anything else?",
        nextState: {
          phase: "CONFIRM_MESSAGE",
          messageParts: [...(state.messageParts ?? []), utterance],
          activeGuest: state.activeGuest,
          messageSaved: state.messageSaved,
        },
        effects: [],
      };
    }

    case "CONFIRM_MESSAGE": {
      // Caller finished the message — save/notify once, keep listening (no hangup).
      if (!utterance || isSoftCloseUtterance(utterance)) {
        return finalizeTakenMessage(state);
      }

      // Transfer refusal while confirming — finalize once, never transfer.
      if (hasTransferNegation(utterance)) {
        const finalized = finalizeTakenMessage(state, {
          keepListeningPrompt: false,
        });
        const declined = await handleTransferDecline(
          utterance,
          deps,
          finalized.nextState
        );
        return {
          ...declined,
          reply: declined.reply,
          effects: [...finalized.effects, ...declined.effects],
        };
      }

      // Continued guest question / clarify subject / new arrival / connect after
      // leaving a message: finalize once, then handle the new intent (no hangup).
      if (
        looksLikeGuestInfoFollowUp(utterance, state) ||
        looksLikeNewVisitorAnnouncement(utterance, state) ||
        deskSubjectFor(utterance, state).kind === "clarify" ||
        detectExplicitTransfer(utterance) ||
        (VISITOR_RE.test(utterance) && extractName(utterance))
      ) {
        const finalized = finalizeTakenMessage(state, {
          keepListeningPrompt: false,
        });
        const next = await handleIntent(utterance, deps, finalized.nextState);
        return {
          ...next,
          effects: [...finalized.effects, ...next.effects],
        };
      }

      return {
        reply: "Got it. Anything else?",
        nextState: {
          phase: "CONFIRM_MESSAGE",
          messageParts: [...(state.messageParts ?? []), utterance],
          activeGuest: state.activeGuest,
          messageSaved: state.messageSaved,
        },
        effects: [],
      };
    }

    case "DONE":
      // Stay soft — if the call somehow continues, don't force another hangup.
      return softClose(state);
  }
}

/** Save+notify a taken message exactly once, then return to listening. */
function finalizeTakenMessage(
  state: CallState,
  opts: { keepListeningPrompt?: boolean } = {}
): CallflowResult {
  const keepPrompt = opts.keepListeningPrompt !== false;
  const body = (state.messageParts ?? []).join(" ").trim();
  if (state.messageSaved || !body) {
    return {
      reply: keepPrompt
        ? "Okay — I'm here if you need anything else."
        : "",
      nextState: withGuest({ ...state, messageSaved: true, messageParts: [] }),
      effects: [],
    };
  }
  return {
    reply: keepPrompt
      ? "Thank you — I'll pass that along to Scott and Monica. I'm here if you need anything else."
      : "",
    nextState: withGuest({
      ...state,
      messageSaved: true,
      messageParts: [],
    }),
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
      // New message-taking session: allow a distinct message even if an
      // earlier failed-transfer message on this call was already saved.
      // Same-session finalize still dedupes via messageSaved flipping true.
      messageSaved: false,
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
