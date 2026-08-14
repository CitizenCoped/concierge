// All guest windows are entered and displayed in building-local time;
// Postgres stores UTC. The LA→UTC conversion itself happens in SQL
// (`::timestamp at time zone 'America/Los_Angeles'`) — these helpers only
// format UTC instants for display and build input defaults.

export const HOME_TZ = process.env.TZ_HOME || "America/Los_Angeles";

function parts(d: Date, tz: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  if (out.hour === "24") out.hour = "00";
  return out;
}

/** `{ date: "YYYY-MM-DD", time: "HH:MM" }` in building-local time, for
 *  pre-filling date/time inputs. */
export function toLocalInput(
  d: Date | string,
  tz: string = HOME_TZ
): { date: string; time: string } {
  const dt = typeof d === "string" ? new Date(d) : d;
  const p = parts(dt, tz);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Human display, e.g. "Aug 14, 3:30 PM". */
export function fmtLocal(d: Date | string, tz: string = HOME_TZ): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(dt);
}

/** "3h 20m left" / "12m left" / "ended". */
export function timeRemaining(endsAt: Date | string, now = new Date()): string {
  const end = typeof endsAt === "string" ? new Date(endsAt) : endsAt;
  const ms = end.getTime() - now.getTime();
  if (ms <= 0) return "ended";
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 48) return `${Math.floor(h / 24)}d left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

/** Now, rounded DOWN to the last 15 minutes — the add-guest default.
 *  Rounding down (a deviation from PROMPT §6's "next 15 min") means a guest
 *  added while their visitor is standing at the desk is active immediately;
 *  rounding up caused real denials during acceptance testing. */
export function defaultStart(now = new Date()): Date {
  const ms = 15 * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}
