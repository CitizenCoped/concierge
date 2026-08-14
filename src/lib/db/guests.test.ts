import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./index";
import { matchGuest } from "./guests";

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
});

afterAll(async () => {
  await db()`delete from guests where name like ${"%" + runId + "%"}`;
});

describe("matchGuest", () => {
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
});
