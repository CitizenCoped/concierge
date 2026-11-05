import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./index";
import {
  matchGuest,
  matchGuestAgainst,
  soundex,
  tokenClose,
  type GuestNameRow,
} from "./guests";

// Live-DB tests: seed uniquely-named guests, exercise the matching query,
// clean up. Names carry a random run id so parallel runs can't collide.
const runId = Math.random().toString(36).slice(2, 8);
const N = (base: string) => base.replace("%", runId);

async function seed(
  name: string,
  offsetStartMin: number,
  offsetEndMin: number,
  archived = false
) {
  await db()`
    insert into guests (name, starts_at, ends_at, archived)
    values (${name},
            now() + make_interval(mins => ${offsetStartMin}),
            now() + make_interval(mins => ${offsetEndMin}),
            ${archived})`;
}

beforeAll(async () => {
  // window logic: same name, three windows — only the active one may match
  await seed(N("Winifred% Actor"), -60, 60);
  await seed(N("Winifred% Actor"), -300, -120); // expired
  await seed(N("Winifred% Actor"), 120, 300); // future
  // first-name fallback, unique
  await seed(N("Quorra% Smith"), -60, 60);
  // ambiguous first name
  await seed(N("Dupla% Smith"), -60, 60);
  await seed(N("Dupla% Jones"), -60, 60);
  // archived guest, otherwise active
  await seed(N("Archie% Vault"), -60, 60, true);
  // fuzzy: STT-mangled surname (the live "Ebsen" → "Epson"/"Edson" case)
  await seed(N("Malice% Ebsen"), -60, 60);
  // fuzzy ambiguity: two guests within edit distance of the same misheard name
  await seed(N("Twin% Abcde"), -60, 60);
  await seed(N("Twin% Abcdi"), -60, 60);
  // phonetic: Sera ↔ Sarah ↔ Sierra. Put runId in the LAST name so
  // last-name-only tests can't collide with a real active "… Connor".
  await seed(N("Sera Conn%"), -60, 60);
});

afterAll(async () => {
  await db()`delete from guests where name like ${"%" + runId + "%"}`;
});

describe("matchGuest (live DB)", () => {
  it("admits an exact match only within the active window", async () => {
    const r = await matchGuest(N("  winifred% actor "));
    expect(r.match?.name).toBe(N("Winifred% Actor"));
    expect(r.candidates).toHaveLength(1);
  });

  it("denies an expired guest", async () => {
    const r = await matchGuest(N("Expired% Person"));
    expect(r.match).toBeNull();
    expect(r.candidates).toHaveLength(0);
  });

  it("denies an archived guest even inside its window", async () => {
    const r = await matchGuest(N("Archie% Vault"));
    expect(r.match).toBeNull();
  });

  it("first-name fallback admits when unique", async () => {
    const r = await matchGuest(N("Quorra%"));
    expect(r.match?.name).toBe(N("Quorra% Smith"));
  });

  it("first-name fallback denies when ambiguous", async () => {
    const r = await matchGuest(N("Dupla%"));
    expect(r.match).toBeNull();
    expect(r.candidates).toHaveLength(2);
  });

  it("never admits on a full-name mismatch sharing a first name", async () => {
    const r = await matchGuest(N("Quorra% Brown"));
    expect(r.match).toBeNull();
    expect(r.candidates).toHaveLength(0);
  });

  it("fuzzy: admits an STT-mangled surname (Ebsen heard as Epson)", async () => {
    const r = await matchGuest(N("Malice% Epson"));
    expect(r.match?.name).toBe(N("Malice% Ebsen"));
  });

  it("fuzzy: admits when the last token is close and a middle name context differs", async () => {
    const r = await matchGuest(N("Malice% Edson"));
    expect(r.match?.name).toBe(N("Malice% Ebsen"));
  });

  it("fuzzy: fails closed when two guests are equally close", async () => {
    const r = await matchGuest(N("Twin% Abcdz"));
    expect(r.match).toBeNull();
    expect(r.candidates.length).toBeGreaterThan(1);
  });

  it("fuzzy: does not admit wildly different names", async () => {
    const r = await matchGuest("Completely Unrelated Person");
    expect(r.match).toBeNull();
  });

  it("phonetic: admits Sarah + unique surname for listed Sera", async () => {
    const r = await matchGuest(N("Sarah Conn%"));
    expect(r.match?.name).toBe(N("Sera Conn%"));
  });

  it("phonetic: admits Sara + unique surname spelling for listed Sera", async () => {
    const r = await matchGuest(N("Sara Conn%"));
    expect(r.match?.name).toBe(N("Sera Conn%"));
  });

  it("phonetic: admits Sierra + unique surname", async () => {
    const r = await matchGuest(N("Sierra Conn%"));
    expect(r.match?.name).toBe(N("Sera Conn%"));
  });

  it("last-name-only admits when the surname is unique among active guests", async () => {
    const surname = N("Conn%"); // "Conn" + runId, not a real guest surname
    const r = await matchGuest(surname);
    expect(r.match?.name).toBe(N("Sera Conn%"));
  });
});

describe("matchGuestAgainst (in-memory)", () => {
  const guests: GuestNameRow[] = [
    { id: "1", name: "Sera Connor" },
    { id: "2", name: "Malice Ebsen" },
  ];

  it("matches Sarah Connor / Sara Conner / Sierra Connor → Sera Connor", () => {
    for (const spoken of ["Sarah Connor", "Sara Conner", "Sierra Connor"]) {
      const r = matchGuestAgainst(spoken, guests);
      expect(r.match?.name).toBe("Sera Connor");
    }
  });

  it("matches unique last name alone", () => {
    expect(matchGuestAgainst("Connor", guests).match?.name).toBe("Sera Connor");
    expect(matchGuestAgainst("Conner", guests).match?.name).toBe("Sera Connor");
  });

  it("fails closed on ambiguous phonetic first names", () => {
    const ambiguous: GuestNameRow[] = [
      { id: "1", name: "Sera Connor" },
      { id: "2", name: "Sarah Smith" },
    ];
    const r = matchGuestAgainst("Sarah", ambiguous);
    expect(r.match).toBeNull();
    expect(r.candidates.length).toBeGreaterThan(1);
  });

  it("fails closed when two full names are equally close", () => {
    const twins: GuestNameRow[] = [
      { id: "1", name: "Twin Abcde" },
      { id: "2", name: "Twin Abcdi" },
    ];
    const r = matchGuestAgainst("Twin Abcdz", twins);
    expect(r.match).toBeNull();
    expect(r.candidates.length).toBe(2);
  });

  it("does not admit a shared first name with the wrong last name", () => {
    const r = matchGuestAgainst("Sera Jones", guests);
    expect(r.match).toBeNull();
  });
});

describe("tokenClose / soundex helpers", () => {
  it("treats Sera/Sarah/Sierra as close", () => {
    expect(tokenClose("sera", "sarah")).toBe(true);
    expect(tokenClose("sera", "sierra")).toBe(true);
    expect(soundex("sera")).toBe(soundex("sarah"));
    expect(soundex("connor")).toBe(soundex("conner"));
  });

  it("does not treat unrelated tokens as close", () => {
    expect(tokenClose("sera", "malice")).toBe(false);
    expect(tokenClose("connor", "ebsen")).toBe(false);
  });
});
