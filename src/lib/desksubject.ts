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
 *
 * Note reuse is fail-closed: answer from activeGuest notes ONLY when the turn
 * clearly refers to that guest — unambiguous name match, she/her continuity, or
 * bare the-guest deixis without a location, and with NO competing new-person /
 * new-arrival signal at all. Deictic + location alone clarifies. Otherwise
 * clarify (or new_arrival when the arrival cue is high-confidence).
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
 * - there is / I have + entity at a desk location (incl. "here")
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
 * "There is a housekeeper at the door/here" / "I have a cleaner downstairs" /
 * "I have someone here" — structural entity+location intro (excludes deictic
 * the/our guest and packages). Location set includes bare "here".
 */
const ENTITY_AT_LOCATION_RE = new RegExp(
  `\\b(?:there(?:'s| is)|i have|i'?ve got|we have|got)\\s+(?:an?\\s+)?(?!${DEICTIC_DET}|question|package|parcel|delivery\\b)[\\w'-]+(?:\\s+[\\w'-]+){0,3}\\s+(?:at the door|downstairs|in the lobby|outside|waiting|here|arrived)\\b`,
  "i"
);

const INDEFINITE_SOMEONE_RE = /\b(?:someone|somebody)\b/i;

// Keep in sync with LOCATION_RE for here/arrived — otherwise deictic+here
 // turns skip clarify (not isInfoSeeking) and fall through to unrelated note reuse.
const ACCESS_OR_INFO_RE =
  /\?|\b(?:allowed|permission|permitted|access|park|parking|garage|enter|entry|come up|go up|come in|send (?:him|her|them) up|let (?:him|her|them)|expected|instructions?|delivery|tell (?:her|him|them)|downstairs|lobby|front desk|door|outside|waiting|arrived|here)\b/i;

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

/** "a friend of Jane" / companion framing — never the known guest alone. */
const COMPANION_OF_RE =
  /\b(?:a\s+)?(?:friend|colleague|coworker|guest|visitor|plus\s*one|husband|wife|partner|son|daughter|mother|father|mom|dad|brother|sister|driver|family\s+member)\s+of\b/i;

/** Trailing fillers that are not surname tokens in "can Jane please come up?". */
const ACCESS_NAME_TRAILING_FILLER_RE =
  /^(please|still|just|now|also|again|yet|too|really|already)$/i;

/**
 * Normalize a captured access-name span: strip trailing adverbs/fillers only.
 * Do NOT strip leading a/an/the/my — those can be real given names (An, My).
 * Reject pronouns and whole deictic guest/visitor phrases.
 */
function cleanAccessPersonName(
  raw: string,
  guest?: DeskGuestRef | null
): string | null {
  const parts = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (
    parts.length &&
    ACCESS_NAME_TRAILING_FILLER_RE.test(parts[parts.length - 1]!)
  ) {
    parts.pop();
  }
  const cleaned = parts.join(" ").trim();
  if (!cleaned) return null;
  // Pronouns / indefinite / bare role — not a person name for access routing.
  if (
    /^(she|he|they|her|him|them|someone|somebody|guest|visitor)$/i.test(
      cleaned
    )
  ) {
    return null;
  }
  // Bare determiner-shaped tokens are usually debris, but keep them when they
  // match the known guest's given name (An, My).
  if (/^(the|a|an|this|that|our|my|your)$/i.test(cleaned)) {
    if (guest && namesReferToSameGuest(cleaned, guest.name)) return cleaned;
    return null;
  }
  // Whole deictic role phrases ("the guest", "our visitor") — not a new name.
  if (
    /^(?:the|this|that|our|my|your|his|her|their)\s+(?:guest|visitor)$/i.test(
      cleaned
    )
  ) {
    return null;
  }
  return cleaned;
}

/**
 * Access request naming a person ("can Bob come up?", "send Sarah up").
 * Does not treat deictic the/our guest or trailing "please/still" as a name.
 */
function accessPersonName(
  utterance: string,
  guest?: DeskGuestRef | null
): string | null {
  const patterns = [
    /\b(?:can|could|may|should)\s+([A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,2})\s+(?:come\s+up|go\s+up|come\s+in|enter)\b/i,
    /\b(?:send|let)\s+([A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,2})\s+up\b/i,
  ];
  for (const re of patterns) {
    const m = utterance.match(re);
    const raw = m?.[1]?.trim();
    if (!raw) continue;
    const cleaned = cleanAccessPersonName(raw, guest);
    if (cleaned) return cleaned;
  }
  return null;
}

/** Access-named person that is NOT the active guest (Bob after Jane). */
function otherAccessPersonName(
  utterance: string,
  guest: DeskGuestRef | null
): string | null {
  const raw = accessPersonName(utterance, guest);
  if (!raw) return null;
  if (guest && namesReferToSameGuest(raw, guest.name)) return null;
  return raw;
}

/**
 * Any cue that the turn may be about a person other than activeGuest.
 * Blocks same_guest note reuse (including when the known guest's name is
 * merely mentioned alongside a different person).
 */
function hasCompetingPersonSignal(
  utterance: string,
  named: string | null,
  guest: DeskGuestRef | null,
  personIntro: boolean
): boolean {
  if (EXPLICIT_OTHER_RE.test(utterance)) return true;
  if (INDEFINITE_SOMEONE_RE.test(utterance)) return true;
  if (COMPANION_OF_RE.test(utterance)) return true;
  if (personIntro) return true;
  if (OTHER_PRONOUN_RE.test(utterance)) return true;
  if (otherAccessPersonName(utterance, guest)) return true;
  if (
    named &&
    guest &&
    !namesReferToSameGuest(named, guest.name)
  ) {
    return true;
  }
  return false;
}

/** Presence / arrival framing around an indefinite someone. */
function someoneArrivalFramed(utterance: string): boolean {
  if (!INDEFINITE_SOMEONE_RE.test(utterance)) return false;
  if (LOCATION_RE.test(utterance)) return true;
  if (looksLikePersonIntro(utterance)) return true;
  if (EXPLICIT_OTHER_RE.test(utterance)) return true;
  // "someone new" / "somebody new" — structural adj after indefinite person.
  if (/\b(?:someone|somebody)\s+new\b/i.test(utterance)) return true;
  // Access-request verbs aimed at sending a person up / letting them in.
  if (
    /\b(?:come up|go up|come in|send (?:him|her|them) up|let (?:him|her|them)|park|parking|garage|access|enter|entry)\b/i.test(
      utterance
    )
  ) {
    return true;
  }
  return false;
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
  const competing = hasCompetingPersonSignal(u, named, guest, personIntro);

  // --- High-confidence NEW ARRIVAL ---
  if (EXPLICIT_OTHER_RE.test(u)) {
    return { kind: "new_arrival", named };
  }

  // Indefinite someone + info/access: never reuse notes.
  // Arrival-framed → ask for a name; otherwise clarify when a guest is active
  // (e.g. "Did someone leave instructions for her?").
  if (INDEFINITE_SOMEONE_RE.test(u) && isInfoSeeking(u)) {
    if (!guest || someoneArrivalFramed(u) || personIntro) {
      return { kind: "new_arrival", named };
    }
    return { kind: "clarify" };
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

  // Competing other person named for access ("can Bob come up?") while a
  // prior guest is active — treat as new arrival, never reuse notes.
  const otherAccess = guest ? otherAccessPersonName(u, guest) : null;
  if (guest && otherAccess) {
    return { kind: "new_arrival", named: otherAccess };
  }
  if (guest && COMPANION_OF_RE.test(u) && (arrivalContext || isInfoSeeking(u))) {
    return {
      kind: "new_arrival",
      named:
        named && !namesReferToSameGuest(named, guest.name) ? named : null,
    };
  }

  // --- High-confidence SAME GUEST (fail-closed note reuse) ---
  // Unambiguous name match only when there is NO competing person signal
  // (blocks "friend of Jane" / "Jane is here, can Bob…" note reuse).
  // she/her continuity, or bare the-guest deixis WITHOUT a location.
  // "I have the guest here, can she come up?" keeps notes via she/her.
  if (guest) {
    if (
      named &&
      namesReferToSameGuest(named, guest.name) &&
      !competing
    ) {
      return { kind: "same_guest" };
    }
    // "Can Jane come up?" — access name matches active guest, no competitor.
    const accessName = accessPersonName(u, guest);
    if (
      accessName &&
      namesReferToSameGuest(accessName, guest.name) &&
      !competing
    ) {
      return { kind: "same_guest" };
    }
    if (
      !competing &&
      (SAME_PRONOUN_RE.test(u) ||
        (DEICTIC_GUEST_RE.test(u) && !LOCATION_RE.test(u)))
    ) {
      return { kind: "same_guest" };
    }
  }

  // --- AMBIGUOUS with a known guest in play ---
  if (guest && isInfoSeeking(u)) {
    if (
      competing ||
      otherAccess ||
      SAME_PRONOUN_RE.test(u) ||
      DEICTIC_GUEST_RE.test(u) ||
      /\b(?:visitor|guest|downstairs|lobby|door|outside|here|arrived)\b/i.test(u)
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
