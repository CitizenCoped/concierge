/**
 * Delivery-list guest helpers.
 *
 * Owner maintains a guest-list entry whose name is the single word "Delivery"
 * (with a normal time window). Food/courier arrivals match that entry exactly —
 * never via phonetic/fuzzy name matching — and approve send-up to unit 305.
 * Fail closed: no active Delivery entry ⇒ do not approve.
 */

/** Condo unit for approved deliveries — named constant, not an env var. */
export const CONDO_UNIT = "305";

/** Canonical guest-list name the owner should enter. */
export const DELIVERY_LIST_NAME = "Delivery";

/**
 * Normalize for Delivery identity: case-insensitive, strip whitespace +
 * punctuation so "Delivery", "delivery.", " Delivery! " all match.
 */
export function normalizeDeliveryToken(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** True when a guest-list (or spoken) name is the reserved Delivery entry. */
export function isDeliveryListName(name: string): boolean {
  return normalizeDeliveryToken(name) === "delivery";
}

/** Courier brands — never enough alone; need arrival/access framing. */
const FOOD_BRAND_RE =
  /\b(?:door\s*dash|doordash|uber\s*eats|ubereats|instacart|grub\s*hub|grubhub|postmates)\b/i;

/** Explicit food/courier delivery phrases (still require arrival/access). */
const FOOD_DELIVERY_PHRASE_RE =
  /\b(?:food\s+delivery|grocer(?:y|ies)\s+delivery|take[\s-]?out\s+delivery|meal\s+kit(?:\s+delivery)?)\b/i;

const FOOD_OR_GROCERIES_RE = /\b(?:food|groceries|grocery|take[\s-]?out)\b/i;

const DELIVERY_COURIER_RE =
  /\b(?:delivery\s+(?:person|driver|courier)|(?:a|an|the)\s+courier)\b/i;

/** "I have a delivery…" / "there's a delivery…" intro. */
const DELIVERY_INTRO_RE =
  /\b(?:i have|i'?ve got|we have|there'?s|there is|got)\s+(?:a\s+)?delivery\b/i;

/** Presence locations bound to a food noun (subset of arrival cues). */
const FOOD_LOCATION =
  "here|downstairs|outside|waiting|arrived|at the door|at the front desk|in the lobby|lobby";

/**
 * Takeout/food/groceries announced at a location without needing the word
 * "delivery" — "Takeout is here", "Takeout's here", "There's food downstairs".
 * Location must be attached to the food noun (not a distant "can she" elsewhere).
 */
const FOOD_AT_LOCATION_RE = new RegExp(
  `\\b(?:take[\\s-]?out|food|grocer(?:y|ies))(?:'s|\\s+is|\\s+are)\\s+(?:${FOOD_LOCATION})\\b`,
  "i"
);

/** "There's takeout downstairs" / "I have food here" — location near the food. */
const HAVE_FOOD_ARRIVAL_RE = new RegExp(
  `\\b(?:i have|i'?ve got|we have|there'?s|there is|got)\\s+(?:an?\\s+)?(?:take[\\s-]?out|food|grocer(?:y|ies))\\b(?:\\s+\\w+){0,4}\\s+(?:${FOOD_LOCATION})\\b`,
  "i"
);

const ARRIVAL_OR_ACCESS_RE =
  /\b(?:here|downstairs|lobby|outside|waiting|arrived|at the door|at the front desk|come up|go up|come in|send (?:him|her|them) up|let (?:him|her|them)|can they|can he|can she)\b/i;

/**
 * Package/delivery/food/question addressed to a named person — not the
 * Delivery list entry (existing "delivery for Jane" behavior).
 * Exclude common non-name tails (the unit, you, us, Scott/Monica).
 */
const PACKAGE_FOR_NAMED_RE =
  /\b(?:package|parcel|delivery|question|food|take[\s-]?out|grocer(?:y|ies))\s+for\s+(?!delivery\b)(?!the\b|a\b|an\b|you\b|us\b|them\b|him\b|her\b|me\b|scott\b|monica\b|unit\b|condo\b)[A-Za-z]/i;

/**
 * Clarify-reply confirmations: whole-turn only — bare "Delivery",
 * "it's a delivery", "yes, a delivery". Never prefix-match guest-info
 * questions ("Yes delivery should be left…") or "delivery for Jane".
 */
export function looksLikeDeliveryClarifyReply(utterance: string): boolean {
  const u = utterance.trim();
  if (!u) return false;
  if (PACKAGE_FOR_NAMED_RE.test(u)) return false;
  // Whole utterance only (trailing punctuation/whitespace OK).
  if (/^\s*(?:it'?s\s+)?(?:a\s+)?delivery[.!,?\s]*$/i.test(u)) return true;
  if (
    /^\s*(?:yes|yeah|yep|yup|correct|right)[,.]?\s+(?:it'?s\s+)?(?:a\s+)?delivery[.!,?\s]*$/i.test(
      u
    )
  ) {
    return true;
  }
  return false;
}

/** Clarify-reply picking visitor (not delivery). */
export function looksLikeVisitorClarifyReply(utterance: string): boolean {
  const u = utterance.trim();
  if (!u) return false;
  if (looksLikeDeliveryClarifyReply(u)) return false;
  if (/^\s*(?:a\s+)?(?:visitor|guest)[.!,?\s]*$/i.test(u)) return true;
  if (
    /^\s*(?:yes|yeah|yep|yup|correct|right|it'?s)[,.]?\s+(?:a\s+)?(?:visitor|guest)[.!,?\s]*$/i.test(
      u
    )
  ) {
    return true;
  }
  if (/^\s*(?:someone new|somebody new|a person)[.!,?\s]*$/i.test(u)) {
    return true;
  }
  return false;
}

/**
 * High-confidence food/courier delivery arrival — match the Delivery list
 * entry rather than asking for the courier's personal name.
 *
 * Fail closed: food/brand/grocery words alone never approve — require
 * arrival/access framing (or an explicit clarify reply).
 */
export function looksLikeDeliveryTypeArrival(utterance: string): boolean {
  const u = utterance.trim();
  if (!u) return false;
  if (PACKAGE_FOR_NAMED_RE.test(u)) return false;

  // After "delivery or visitor?" — accept terse delivery confirmations.
  if (looksLikeDeliveryClarifyReply(u)) return true;

  const hasArrival = ARRIVAL_OR_ACCESS_RE.test(u);
  if (!hasArrival) return false;

  if (FOOD_BRAND_RE.test(u) || FOOD_DELIVERY_PHRASE_RE.test(u)) return true;
  // "Takeout is/’s here" / "There's food downstairs" — location bound to food.
  if (FOOD_AT_LOCATION_RE.test(u) || HAVE_FOOD_ARRIVAL_RE.test(u)) return true;
  if (FOOD_OR_GROCERIES_RE.test(u) && /\bdeliver/i.test(u)) return true;
  if (
    FOOD_OR_GROCERIES_RE.test(u) &&
    /\b(?:delivery|delivering|delivered|courier|doordash|uber|instacart)\b/i.test(
      u
    )
  ) {
    return true;
  }
  if (DELIVERY_COURIER_RE.test(u)) return true;
  if (DELIVERY_INTRO_RE.test(u)) return true;
  return false;
}

/**
 * Both visitor/guest framing and a delivery mention without a clear
 * food-service cue — ask rather than guess.
 */
export function isAmbiguousDeliveryOrVisitor(utterance: string): boolean {
  const u = utterance.trim();
  if (!u) return false;
  // Clear food/courier arrivals are never ambiguous (unless also framed as a
  // visitor/guest person — then still ask).
  if (looksLikeDeliveryTypeArrival(u) && !hasVisitorPersonFraming(u)) {
    return false;
  }
  const hasDeliveryWord = /\bdeliver(?:y|ies|ing)?\b/i.test(u);
  if (!hasDeliveryWord) return false;
  if (
    FOOD_BRAND_RE.test(u) ||
    FOOD_DELIVERY_PHRASE_RE.test(u) ||
    FOOD_OR_GROCERIES_RE.test(u)
  ) {
    return false;
  }
  if (DELIVERY_COURIER_RE.test(u) && ARRIVAL_OR_ACCESS_RE.test(u)) {
    return hasVisitorPersonFraming(u);
  }
  if (DELIVERY_INTRO_RE.test(u) && ARRIVAL_OR_ACCESS_RE.test(u)) {
    // Clear "I have a delivery here…" is not ambiguous.
    return hasVisitorPersonFraming(u);
  }
  if (PACKAGE_FOR_NAMED_RE.test(u)) return false;
  return (
    hasVisitorPersonFraming(u) ||
    /\bsomeone\b[\s\S]{0,48}\bdeliver(?:y|ies|ing)?\b/i.test(u)
  );
}

function hasVisitorPersonFraming(utterance: string): boolean {
  return (
    /\b(?:visitor|guest)\b(?!\s+(?:parking|pass|spot|space|permit|sticker|badge)\b)/i.test(
      utterance
    ) && !/\bdelivery\s+(?:person|driver)\b/i.test(utterance)
  );
}

export function clarifyDeliveryOrVisitorPrompt(): string {
  return "Just to confirm — is this a delivery, or a visitor?";
}

/** Spoken approval when an active Delivery entry exists. */
export function deliveryApprovalReply(): string {
  return `Yes, Scott and Monica are expecting a delivery. It's OK to send them up to unit ${CONDO_UNIT}. Is there anything else I can help with?`;
}
