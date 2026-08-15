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

export interface GuestMatch {
  /** Non-null only when the visitor may be admitted (exactly one unambiguous match). */
  match: Guest | null;
  candidates: Guest[];
}

/**
 * Match a spoken visitor name against the active guest list. Window validity
 * (start ≤ now ≤ end) and name matching both happen in SQL.
 *
 * Pass 1: exact case-insensitive trimmed name equality — admit iff 1 row.
 * Pass 2 (only if pass 1 found nothing): first-token match, admit iff 1 row
 * AND the token comparison is safe: either the spoken name is first-name-only
 * or the guest entry is first-name-only. A spoken "Sarah Jones" never admits
 * a listed "Sarah Smith".
 * Pass 3 (only if pass 2 found nothing): STT tolerance — Levenshtein distance
 * on the whole name (≤ max(2, len/6)), or first tokens within 1 edit AND last
 * tokens within 2 edits (covers dropped middle names). Admit iff exactly 1
 * row; any ambiguity fails closed. Live-driven: STT heard "Epson"/"Edson"
 * for a real guest named "Ebsen" and exact matching denied her.
 */
export async function matchGuest(spokenName: string): Promise<GuestMatch> {
  const sql = db();
  const exact = (await sql`
    select * from guests
    where archived = false
      and now() between starts_at and ends_at
      and lower(name) = lower(trim(${spokenName}))
  `) as Guest[];
  if (exact.length > 0) {
    return { match: exact.length === 1 ? exact[0] : null, candidates: exact };
  }

  const trimmed = spokenName.trim();
  if (!trimmed) return { match: null, candidates: [] };

  const fallback = (await sql`
    select * from guests
    where archived = false
      and now() between starts_at and ends_at
      and lower(split_part(trim(name), ' ', 1)) =
          lower(split_part(trim(${trimmed}), ' ', 1))
      and (
        position(' ' in trim(${trimmed})) = 0
        or position(' ' in trim(name)) = 0
      )
  `) as Guest[];
  if (fallback.length > 0) {
    return {
      match: fallback.length === 1 ? fallback[0] : null,
      candidates: fallback,
    };
  }

  if (trimmed.length < 4) return { match: null, candidates: [] };
  const tokens = trimmed.toLowerCase().split(/\s+/);
  const firstToken = tokens[0];
  const lastToken = tokens[tokens.length - 1];
  const fuzzy = (await sql`
    select * from guests
    where archived = false
      and now() between starts_at and ends_at
      and (
        levenshtein(lower(trim(name)), lower(${trimmed}))
          <= greatest(2, length(${trimmed}) / 6)
        or (
          ${tokens.length > 1}
          and position(' ' in trim(name)) > 0
          and levenshtein(lower(split_part(trim(name), ' ', 1)), ${firstToken}) <= 1
          and levenshtein(
                lower(regexp_replace(trim(name), '^.*\\s', '')), ${lastToken}) <= 2
        )
      )
  `) as Guest[];
  return {
    match: fuzzy.length === 1 ? fuzzy[0] : null,
    candidates: fuzzy,
  };
}
