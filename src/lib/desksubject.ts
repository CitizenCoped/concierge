/**
 * Desk-turn subject classification.
 *
 * Conservative contract (security + continuity):
 * - same_guest: high confidence this turn is about the known activeGuest
 * - new_arrival: high confidence a different/unnamed person is being introduced
 * - clarify: activeGuest is set but reference is ambiguous — ask, never answer
 *   from prior notes and never invent permissions for an unnamed person
 * - unrelated: not a guest-subject / arrival turn (packages, etc. handled elsewhere)
 *
 * Prefer ask-over-guess. Avoid stacking unrelated phrase lists: use structural
 * cues (person intro, location arrival, deixis, pronouns) with fail-closed ties.
 * Reuse of activeGuest requires an unambiguous name match (full name, or a
 * single-token first name with no conflicting surname).
 */

export type DeskSubjectKind =
  | "same_guest"
  | "new_arrival"
  | "clarify"
  | "unrelated";

export type DeskSubject =
  | { kind: "same_guest" }
  | { kind: "new_arrival"; named: string | null }
  | { kind: "clarify" }
  | { kind: "unrelated" };

export type DeskGuestRef = { name: string };

/** Explicit "someone else / another guest" — never the known guest. */
const EXPLICIT_OTHER_RE =
  /\b(?:another (?:guest|visitor|person)|someone else|somebody else|different (?:guest|visitor|person)|new (?:guest|visitor)|also (?:have|got)\s+(?:an?\s+)?(?:guest|visitor|someone|somebody)|one more (?:guest|visitor|person)|second (?:guest|visitor))\b/i;

/** Compound nouns that look like "visitor …" but are not a person. */
const VISITOR_NONPERSON_TAIL =
  "(?:parking|pass|spot|space|permit|sticker|badge)";

/** Determiners that refer back to the known guest — not a new person intro. */
const DEICTIC_DET = "the|this|that|my|our|his|her|their";

/**
 * Structural person introduction — not an open-ended phrase list.
 * - Role nouns (man/woman/delivery person/…)
 * - Optional short adjective before guest/visitor (female guest, new visitor)
 * - have/got/there's + optional a/an + optional non-deictic adj + guest/visitor
 * - Bare guest/visitor + location (excluding deictic the/our/my guest)
 * - there is / I have + entity at a desk location (housekeeper at the door)
 */
const ROLE_PERSON_RE =
  /\b(?:(?:a|an|the|another|new|some)\s+)?(?:man|woman|guy|lady|gentleman|person|courier|driver|delivery\s+person)\b/i;

const ADJ_GUEST_RE = new RegExp(
  `\\b(?:female|male|new)\\s+(?:visitor|guest)\\b(?!\\s+${VISITOR_NONPERSON_TAIL})\\b`,
  "i"
);

const HAVE_GUEST_RE = new RegExp(
  `\\b(?:got|have|there's|there is|i have|i'?ve got|we have)\\s+(?:an?\\s+)?(?:(?!${DEICTIC_DET}|question|package|delivery|update|message|note)\\w+\\s+){0,2}(?:visitor|guest)\\b(?!\\s+${VISITOR_NONPERSON_TAIL})\\b`,
  "i"
);

const ARTICLE_GUEST_RE = new RegExp(
  `\\b(?:a|an|another|new)\\s+(?:(?!question)\\w+\\s+){0,1}(?:visitor|guest)\\b(?!\\s+${VISITOR_NONPERSON_TAIL})\\b`,
  "i"
);

/** "Guest in the lobby…" — not deictic "the/our/my guest". */
const BARE_GUEST_LOCATION_RE = new RegExp(
  `(?<!\\b(?:${DEICTIC_DET})\\s)\\b(?:visitor|guest)\\b(?!\\s+${VISITOR_NONPERSON_TAIL})\\b(?:\\s+\\w+){0,4}\\s+(?:in\\s+the\\s+(?:lobby|building)|at\\s+the\\s+(?:door|front\\s+desk)|downstairs|lobby|outside|waiting|here|asking)\\b`,
  "i"
);

/**
 * "There is a housekeeper at the door" / "I have a cleaner downstairs" —
 * structural entity+location intro (excludes deictic the/our guest and packages).
 */
const ENTITY_AT_LOCATION_RE = new RegExp(
  `\\b(?:there(?:'s| is)|i have|i'?ve got|we have|got)\\s+(?:an?\\s+)?(?!${DEICTIC_DET}|question|package|parcel|delivery\\b)[\\w'-]+(?:\\s+[\\w'-]+){0,3}\\s+(?:at the door|downstairs|in the lobby|outside|waiting)\\b`,
  "i"
);

const INDEFINITE_SOMEONE_RE = /\b(?:someone|somebody)\b/i;

const ACCESS_OR_INFO_RE =
  /\?|\b(?:allowed|permission|permitted|access|park|parking|garage|enter|entry|come up|go up|come in|send (?:him|her|them) up|let (?:him|her|them)|expected|instructions?|delivery|tell (?:her|him|them)|downstairs|lobby|front desk|door|outside|waiting)\b/i;

const SAME_PRONOUN_RE = /\b(?:she|her)\b/i;
const OTHER_PRONOUN_RE = /\b(?:he|him|they|them)\b/i;
/** Known-guest deixis: the/this/our/my guest (not a fresh arrival label). */
const DEICTIC_GUEST_RE = new RegExp(
  `\\b(?:${DEICTIC_DET})\\s+(?:guest|visitor)\\b`,
  "i"
);
const LOCATION_RE =
  /\b(?:downstairs|lobby|front desk|at the door|outside|waiting|arrived|here)\b/i;

/**
 * Unambiguous identity match for reusing activeGuest.
 * - Full normalized equality → match
 * - Single-token spoken first name matching guest first name → match (partial ref)
 * - Multi-token spoken with a different surname → NOT a match (Jane Smith ≠ Jane McDaniel)
 */
export function namesReferToSameGuest(
  spoken: string,
  guestName: string
): boolean {
  const gParts = guestName.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sParts = spoken.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!gParts.length || !sParts.length) return false;
  if (gParts.join(" ") === sParts.join(" ")) return true;
  // Partial first-name-only reference to the known guest.
  if (sParts.length === 1 && gParts[0] === sParts[0]) return true;
  // Explicit full-ish name with a conflicting last token → different person.
  if (sParts.length >= 2 && gParts.length >= 2) {
    const gLast = gParts[gParts.length - 1]!;
    const sLast = sParts[sParts.length - 1]!;
    if (sParts[0] === gParts[0] && sLast !== gLast) return false;
    // Spoken tokens are a prefix of the guest's full name.
    if (sParts.every((p, i) => p === gParts[i])) return true;
  }
  return false;
}

function isInfoSeeking(utterance: string): boolean {
  return ACCESS_OR_INFO_RE.test(utterance);
}

/** High-confidence structural cue that a person is being introduced. */
export function looksLikePersonIntro(utterance: string): boolean {
  const u = utterance.trim();
  return (
    ROLE_PERSON_RE.test(u) ||
    ADJ_GUEST_RE.test(u) ||
    HAVE_GUEST_RE.test(u) ||
    ARTICLE_GUEST_RE.test(u) ||
    BARE_GUEST_LOCATION_RE.test(u) ||
    ENTITY_AT_LOCATION_RE.test(u)
  );
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
  const personIntro = looksLikePersonIntro(u);

  // --- High-confidence NEW ARRIVAL ---
  if (EXPLICIT_OTHER_RE.test(u)) {
    return { kind: "new_arrival", named };
  }

  // Indefinite someone + info/access → ask for a name (never reuse notes).
  // "Did someone leave instructions for her?" stays same-guest via she/her.
  if (INDEFINITE_SOMEONE_RE.test(u) && isInfoSeeking(u)) {
    if (
      guest &&
      SAME_PRONOUN_RE.test(u) &&
      !OTHER_PRONOUN_RE.test(u) &&
      !personIntro &&
      !EXPLICIT_OTHER_RE.test(u)
    ) {
      return { kind: "same_guest" };
    }
    return { kind: "new_arrival", named };
  }

  // Delivery/package at the door asking to come up — person, not leave-a-package.
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
    personIntro &&
    !(guest && named && namesReferToSameGuest(named, guest.name))
  ) {
    return { kind: "new_arrival", named };
  }

  // A spoken name alone is NOT enough for new_arrival — need arrival context.
  const arrivalContext =
    EXPLICIT_OTHER_RE.test(u) ||
    personIntro ||
    INDEFINITE_SOMEONE_RE.test(u) ||
    /\b(?:i have|i'?ve got|we have|there is|there'?s|got)\b/i.test(u) ||
    LOCATION_RE.test(u);

  if (
    named &&
    guest &&
    !namesReferToSameGuest(named, guest.name) &&
    arrivalContext
  ) {
    return { kind: "new_arrival", named };
  }
  if (named && !guest && arrivalContext) {
    return { kind: "new_arrival", named };
  }

  // --- High-confidence SAME GUEST ---
  if (guest) {
    if (named && namesReferToSameGuest(named, guest.name)) {
      return { kind: "same_guest" };
    }
    // she/her continuity — only when no competing person / other-pronoun subject.
    // "He is with her, can he come up?" and noun-led arrivals fall through.
    if (
      SAME_PRONOUN_RE.test(u) &&
      !OTHER_PRONOUN_RE.test(u) &&
      !personIntro &&
      !EXPLICIT_OTHER_RE.test(u) &&
      !(named && !namesReferToSameGuest(named, guest.name))
    ) {
      return { kind: "same_guest" };
    }
    // Deictic the/our/my guest — same guest ONLY when not arrival-framed with
    // a competing they/he. "The visitor is downstairs, can they…?" → clarify.
    if (
      DEICTIC_GUEST_RE.test(u) &&
      !EXPLICIT_OTHER_RE.test(u) &&
      !personIntro &&
      !(LOCATION_RE.test(u) && OTHER_PRONOUN_RE.test(u) && isInfoSeeking(u))
    ) {
      // Deictic + she/her / bare deictic question → same guest.
      if (SAME_PRONOUN_RE.test(u) || !LOCATION_RE.test(u)) {
        return { kind: "same_guest" };
      }
    }
  }

  // --- AMBIGUOUS with a known guest in play ---
  if (guest && isInfoSeeking(u)) {
    if (OTHER_PRONOUN_RE.test(u) && !SAME_PRONOUN_RE.test(u)) {
      return { kind: "clarify" };
    }
    // Mixed pronouns or deictic + location → clarify (never guess).
    if (OTHER_PRONOUN_RE.test(u) && SAME_PRONOUN_RE.test(u)) {
      return { kind: "clarify" };
    }
    if (DEICTIC_GUEST_RE.test(u) && LOCATION_RE.test(u)) {
      return { kind: "clarify" };
    }
    if (
      OTHER_PRONOUN_RE.test(u) ||
      SAME_PRONOUN_RE.test(u) ||
      DEICTIC_GUEST_RE.test(u) ||
      /\b(?:visitor|guest|downstairs|lobby|door|outside)\b/i.test(u)
    ) {
      return { kind: "clarify" };
    }
  }

  // Unnamed arrival framing with no active guest → treat as new arrival.
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
