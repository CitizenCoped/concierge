import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db";
import { fmtLocal, timeRemaining, toLocalInput } from "./time";

// The LA→UTC conversion lives in SQL (`::timestamp at time zone ...`) — these
// tests verify it round-trips correctly across midnight and a DST fall-back
// boundary (America/Los_Angeles, Nov 1–2 2025: clocks go back one hour).
const runId = Math.random().toString(36).slice(2, 8);
const name = (s: string) => `TZTest ${s} ${runId}`;

async function insertWindow(label: string, start: string, end: string) {
  const rows = await db()`
    insert into guests (name, starts_at, ends_at)
    values (${name(label)},
            (${start}::timestamp at time zone 'America/Los_Angeles'),
            (${end}::timestamp at time zone 'America/Los_Angeles'))
    returning starts_at, ends_at,
      extract(epoch from ends_at - starts_at)::int as duration_sec`;
  return rows[0] as { starts_at: string; ends_at: string; duration_sec: number };
}

afterAll(async () => {
  await db()`delete from guests where name like ${"TZTest %" + runId}`;
});

describe("LA-time storage and display", () => {
  it("stores a midnight-spanning window with the right duration", async () => {
    const row = await insertWindow("midnight", "2026-09-01 23:00", "2026-09-02 01:00");
    expect(row.duration_sec).toBe(2 * 3600);
    expect(toLocalInput(row.starts_at)).toEqual({ date: "2026-09-01", time: "23:00" });
    expect(toLocalInput(row.ends_at)).toEqual({ date: "2026-09-02", time: "01:00" });
  });

  it("handles the DST fall-back boundary (wall-clock window gains an hour)", async () => {
    // 10 PM Nov 1 → 4 AM Nov 2 2025 is 6 wall-clock hours but 7 real hours.
    const row = await insertWindow("dst", "2025-11-01 22:00", "2025-11-02 04:00");
    expect(row.duration_sec).toBe(7 * 3600);
    expect(toLocalInput(row.starts_at)).toEqual({ date: "2025-11-01", time: "22:00" });
    expect(toLocalInput(row.ends_at)).toEqual({ date: "2025-11-02", time: "04:00" });
  });

  it("formats display strings in LA time", () => {
    // 2026-01-15 02:30 UTC == Jan 14, 6:30 PM PST
    expect(fmtLocal("2026-01-15T02:30:00Z")).toBe("Jan 14, 6:30 PM");
  });

  it("computes time remaining", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(timeRemaining("2026-01-01T03:20:00Z", now)).toBe("3h 20m left");
    expect(timeRemaining("2025-12-31T00:00:00Z", now)).toBe("ended");
  });
});
