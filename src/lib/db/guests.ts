import { isDeliveryListName } from "../delivery";
import { db } from "./index";

export interface Guest {
  id: string;
  name: string;
  guest_info: string | null;
  guest_phone: string | null;
  starts_at: string;
  ends_at: string;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

/** Minimal guest row for name matching + Guest Info Q&A (call-scoped snapshot). */
export type GuestNameRow = Pick<Guest, "id" | "name"> & {
  guest_info?: string | null;
};

export interface GuestMatch {
  /** Non-null only when the visitor may be admitted (exactly one unambiguous match). */
  match: GuestNameRow | null;
  candidates: GuestNameRow[];
}

/** Active (non-archived, inside window) guests — one round-trip. */
export async function listActiveGuests(): Promise<Guest[]> {
  const sql = db();
  return (await sql`
    select * from guests
    where archived = false
      and now() between starts_at and ends_at
    order by name
  `) as Guest[];
}

/**
 * Match a spoken visitor name against the active guest list. Window validity
 * (start ≤ now ≤ end) is enforced by listActiveGuests; name matching is pure.
 *
 * Admit ONLY when exactly one candidate matches. Uses exact, first/last-token,
 * Levenshtein, and Soundex (phonetic) comparison so STT near-misses like
 * "Sarah Connor" ↔ "Sera Connor" or a unique last name alone still admit.
 */
export async function matchGuest(spokenName: string): Promise<GuestMatch> {
  return matchGuestAgainst(spokenName, await listActiveGuests());
}

export function matchGuestAgainst(
  spokenName: string,
  guests: GuestNameRow[]
): GuestMatch {
  const spoken = normalizeName(spokenName);
  if (!spoken || guests.length === 0) return { match: null, candidates: [] };

  // Reserved "Delivery" list name: exact normalized identity only.
  // Never phonetic/fuzzy either direction (Delbert/Deliveries/Deliver ↛ Delivery,
  // and spoken "Delivery" ↛ a real guest).
  const spokenIsDelivery = isDeliveryListName(spokenName);
  const deliveryGuests = guests.filter((g) => isDeliveryListName(g.name));
  const personGuests = guests.filter((g) => !isDeliveryListName(g.name));

  if (spokenIsDelivery) {
    return {
      match: deliveryGuests.length === 1 ? deliveryGuests[0]! : null,
      candidates: deliveryGuests,
    };
  }

  // Spoken is a real name — ignore Delivery entries for all fuzzy passes.
  guests = personGuests;

  const spokenTokens = tokens(spoken);

  // Pass 1: exact full-name equality (case-insensitive).
  const exact = guests.filter((g) => normalizeName(g.name) === spoken);
  if (exact.length > 0) {
    return { match: exact.length === 1 ? exact[0] : null, candidates: exact };
  }

  // Pass 2: single spoken token → unique first-name OR unique last-name close match.
  if (spokenTokens.length === 1) {
    const token = spokenTokens[0];
    const byFirst = guests.filter((g) => tokenClose(token, tokens(g.name)[0] ?? ""));
    if (byFirst.length === 1) {
      return { match: byFirst[0], candidates: byFirst };
    }
    if (byFirst.length > 1) {
      return { match: null, candidates: byFirst };
    }
    const byLast = guests.filter((g) => {
      const t = tokens(g.name);
      return t.length >= 2 && tokenClose(token, t[t.length - 1]);
    });
    return {
      match: byLast.length === 1 ? byLast[0] : null,
      candidates: byLast,
    };
  }

  // Pass 3: multi-token — first+last both close (phonetic or edit distance).
  // Covers "Sarah Connor" ↔ "Sera Connor", "Sara Conner", dropped middle names.
  const fuzzy = guests.filter((g) => {
    const gt = tokens(normalizeName(g.name));
    if (gt.length === 0) return false;
    if (gt.length === 1) {
      // Listed first-name-only: admit only if the spoken first token is close
      // and there is no conflicting extra identity (already handled above for
      // single-token spoken; here require the spoken first to match).
      return tokenClose(spokenTokens[0], gt[0]);
    }
    return (
      tokenClose(spokenTokens[0], gt[0]) &&
      tokenClose(spokenTokens[spokenTokens.length - 1], gt[gt.length - 1])
    );
  });
  return {
    match: fuzzy.length === 1 ? fuzzy[0] : null,
    candidates: fuzzy,
  };
}

function normalizeName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function tokens(name: string): string[] {
  return normalizeName(name)
    .split(/\s+/)
    .map((t) => t.replace(/^[^a-z]+|[^a-z]+$/gi, ""))
    .filter(Boolean);
}

/** True when two name tokens are the same person-sounding token. */
export function tokenClose(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const dist = levenshtein(a, b);
  // Short tokens: only allow a single edit (Ann ↔ Ana). Longer: up to 2.
  const maxDist = Math.min(a.length, b.length) <= 3 ? 1 : 2;
  if (dist <= maxDist) return true;
  // Phonetic: Soundex catches Sera/Sarah/Sierra, Connor/Conner.
  return soundex(a) === soundex(b);
}

/** Classic American Soundex — enough for English guest-name STT drift. */
export function soundex(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return "";
  const map: Record<string, number> = {
    B: 1,
    F: 1,
    P: 1,
    V: 1,
    C: 2,
    G: 2,
    J: 2,
    K: 2,
    Q: 2,
    S: 2,
    X: 2,
    Z: 2,
    D: 3,
    T: 3,
    L: 4,
    M: 5,
    N: 5,
    R: 6,
  };
  let out = s[0];
  let prev: number | undefined = map[s[0]];
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const code = map[s[i]];
    if (code === undefined) {
      prev = undefined;
      continue;
    }
    if (code === prev) continue;
    out += String(code);
    prev = code;
  }
  return (out + "000").slice(0, 4);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[b.length];
}
