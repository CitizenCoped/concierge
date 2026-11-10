/**
 * Desk-turn subject classification.
 *
 * Conservative contract (security + continuity):
 * - same_guest: high confidence this turn is about the known activeGuest
 * - new_arrival: high confidence a different/unnamed person is being introduced
 * - clarify: activeGuest is set but reference is ambiguous — ask, never answer
 *   from prior notes and never invent permissions for an unnamed person
 * - unrelated: not a guest-subject / arrival turn (packages, etc. handled elsewhere)
 */

export type DeskSubjectKind = "same_guest" | "new_arrival" | "clarify" | "unrelated";

export type DeskSubject =
  | { kind: "same_guest" }
  | { kind: "new_arrival"; named: string | null }
  | { kind: "clarify" }
  | { kind: "unrelated" };

export type DeskGuestRef = { name: string };

/** Explicit "someone else / another guest" — never the known guest. */
const EXPLICIT_OTHER_RE =
  /\b(?:another (?:guest|visitor|person)|someone else|somebody else|different (?:guest|visitor|person)|new (?:guest|visitor)|also (?:have|got)\s+(?:an?\s+)?(?:guest|visitor|someone|somebody)|one more (?:guest|visitor|person)|second (?:guest|visitor))\b/i;

/**
 * Introduces a person entity (not compound "visitor parking").
 * Covers security cases: man at the door, delivery person, female visitor.
 */
const PERSON_INTRO_RE =
  /\b(?:(?:a|an|the|another|new|some)\s+)?(?:man|woman|guy|lady|gentleman|person|courier|driver|delivery\s+person|female\s+visitor|male\s+visitor)\b|\b(?:got|have|there's|there is|i have|i'?ve got|we have)\s+(?:an?\s+)?(?:visitor|guest)\b(?!\s+(?:parking|pass|spot|space|permit|sticker|badge))\b|\b(?:a|an|another|new)\s+(?:visitor|guest)\b(?!\s+(?:parking|pass|spot|space|permit|sticker|badge))\b/i;

const INDEFINITE_SOMEONE_RE = /\b(?:someone|somebody)\b/i;

const ACCESS_OR_INFO_RE =
  /\?|\b(?:allowed|permission|permitted|access|park|parking|garage|enter|entry|come up|go up|come in|send (?:him|her|them) up|let (?:him|her|them)|expected|instructions?|delivery|tell (?:her|him|them)|downstairs|lobby|front desk|door|outside|waiting)\b/i;

const SAME_PRONOUN_RE = /\b(?:she|her)\b/i;
const OTHER_PRONOUN_RE = /\b(?:he|him|they|them)\b/i;
const THE_GUEST_RE = /\b(?:the|this)\s+(?:guest|visitor)\b/i;

function namesMatch(spoken: string, guestName: string): boolean {
  const g = guestName.trim().toLowerCase();
  const s = spoken.trim().toLowerCase();
  if (!g || !s) return false;
  if (g === s) return true;
  const gFirst = g.split(/\s+/)[0] ?? "";
  const sFirst = s.split(/\s+/)[0] ?? "";
  return Boolean(gFirst && sFirst && gFirst === sFirst);
}

function isInfoSeeking(utterance: string): boolean {
  return ACCESS_OR_INFO_RE.test(utterance);
}

export interface ClassifyDeskSubjectOpts {
  /** Pre-extracted person name from callflow (preferred over local heuristics). */
  spokenName?: string | null;
}

/**
 * Classify whether this desk turn is about the known guest, a new arrival,
 * needs clarification, or is unrelated to guest subject.
 */
export function classifyDeskSubject(
  utterance: string,
  activeGuest: DeskGuestRef | null | undefined,
  opts: ClassifyDeskSubjectOpts = {}
): DeskSubject {
  const u = utterance.trim();
  if (!u) return { kind: "unrelated" };

  const guest = activeGuest ?? null;
  const named = opts.spokenName?.trim() || null;

  // --- High-confidence NEW ARRIVAL ---
  if (EXPLICIT_OTHER_RE.test(u)) {
    return { kind: "new_arrival", named };
  }
  if (INDEFINITE_SOMEONE_RE.test(u) && isInfoSeeking(u)) {
    return { kind: "new_arrival", named };
  }
  // Delivery/package at the door asking to come up — person, not leave-a-package note.
  if (
    /\b(?:i have|i'?ve got|we have|there'?s|there is|got)\s+(?:a\s+)?(?:delivery|package|parcel)\s+here\b/i.test(
      u
    ) &&
    /\b(come up|go up|come in|send (?:him|her|them) up|let (?:him|her|them)|can they|can he|can she)\b/i.test(
      u
    )
  ) {
    return { kind: "new_arrival", named };
  }
  if (
    PERSON_INTRO_RE.test(u) &&
    !(guest && named && namesMatch(named, guest.name))
  ) {
    return { kind: "new_arrival", named };
  }

  // A spoken name alone is NOT enough for new_arrival — STT/grammar debris
  // ("use visitor", "female visitor") and bare permission questions
  // ("Is Jane allowed…?") must not clear a known guest or skip Guest Info.
  // Require arrival / person-intro / someone-else framing (already handled
  // above) OR an explicit other-person name *with* arrival-ish context.
  const arrivalContext =
    EXPLICIT_OTHER_RE.test(u) ||
    PERSON_INTRO_RE.test(u) ||
    INDEFINITE_SOMEONE_RE.test(u) ||
    /\b(?:i have|i'?ve got|we have|there is|there'?s|got)\b/i.test(u) ||
    /\b(?:downstairs|lobby|front desk|at the door|waiting|arrived)\b/i.test(u);

  if (named && guest && !namesMatch(named, guest.name) && arrivalContext) {
    return { kind: "new_arrival", named };
  }
  if (named && !guest && arrivalContext) {
    return { kind: "new_arrival", named };
  }

  // --- High-confidence SAME GUEST ---
  if (guest) {
    if (named && namesMatch(named, guest.name)) {
      return { kind: "same_guest" };
    }
    // she/her continuity without a competing person intro
    if (
      SAME_PRONOUN_RE.test(u) &&
      !PERSON_INTRO_RE.test(u) &&
      !EXPLICIT_OTHER_RE.test(u)
    ) {
      return { kind: "same_guest" };
    }
    if (
      THE_GUEST_RE.test(u) &&
      !EXPLICIT_OTHER_RE.test(u) &&
      !PERSON_INTRO_RE.test(u)
    ) {
      return { kind: "same_guest" };
    }
  }

  // --- AMBIGUOUS with a known guest in play ---
  // e.g. he/they location+access after Jane was admitted — do NOT reuse notes.
  if (guest && isInfoSeeking(u)) {
    if (OTHER_PRONOUN_RE.test(u) && !SAME_PRONOUN_RE.test(u)) {
      return { kind: "clarify" };
    }
    if (
      OTHER_PRONOUN_RE.test(u) ||
      SAME_PRONOUN_RE.test(u) ||
      THE_GUEST_RE.test(u) ||
      /\b(?:visitor|guest|downstairs|lobby|door|outside)\b/i.test(u)
    ) {
      return { kind: "clarify" };
    }
  }

  // Unnamed arrival framing with no active guest → treat as new arrival (ask name).
  if (
    !guest &&
    /\b(?:i have|i'?ve got|we have|there is|there'?s)\s+(?:an?\s+)?(?:visitor|guest)\b/i.test(
      u
    )
  ) {
    return { kind: "new_arrival", named: null };
  }

  return { kind: "unrelated" };
}

/** Whole-turn hold / pause — never a transfer. */
const HOLD_ONLY_RE =
  /^\s*(?:hold on(?:\s+a\s+(?:sec|second|moment|minute))?(?:\s+please)?|hold please|one (?:sec|second|moment|minute)(?:\s+please)?|just a (?:sec|second|moment|minute)|let me (?:check|see|ask)|give me a (?:sec|second|moment|minute))[.!,?\s]*$/i;

const HOLD_LEAD_RE =
  /^\s*(?:hold on(?:\s+a\s+(?:sec|second|moment|minute))?(?:\s+please)?|hold please|one (?:sec|second|moment|minute)(?:\s+please)?|just a (?:sec|second|moment|minute)|let me (?:check|see|ask)|give me a (?:sec|second|moment|minute))\s*[,.]?\s*/i;

export function isWholeTurnHold(utterance: string): boolean {
  return HOLD_ONLY_RE.test(utterance.trim());
}

/** Strip a leading hold so "Hold on, can she park?" keeps the question. */
export function stripHoldLead(utterance: string): string {
  return utterance.trim().replace(HOLD_LEAD_RE, "").trim();
}

export function clarifySubjectPrompt(guestName: string): string {
  return `Is this about ${guestName}, or someone new?`;
}
