import Link from "next/link";
import { db } from "@/lib/db";
import { fmtLocal } from "@/lib/time";
import { OUTCOME_BADGES } from "@/lib/outcomes";

export const dynamic = "force-dynamic";

interface CallRow {
  id: string;
  agentphone_call_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  from_number: string | null;
  outcome: string | null;
  summary: string | null;
  guest_name: string | null;
}

export default async function CallsPage() {
  const calls = (await db()`
    select c.id, c.agentphone_call_id, c.started_at, c.ended_at, c.from_number,
           c.outcome, c.summary, g.name as guest_name
    from calls c
    left join guests g on g.id = c.matched_guest_id
    order by c.started_at desc nulls last
    limit 100`) as CallRow[];

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-bold">📞 Call Log</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Front-desk calls answered by the concierge
        </p>
      </header>
      {calls.length === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          No calls yet.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {calls.map((call) => {
          const badge = OUTCOME_BADGES[call.outcome ?? ""] ?? OUTCOME_BADGES.hangup;
          return (
            <Link
              key={call.id}
              href={`/calls/${call.id}`}
              className="rounded-2xl border border-neutral-200 bg-white p-4 active:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:active:bg-neutral-800"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {call.started_at ? fmtLocal(call.started_at) : "—"}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
                  {badge.label}
                </span>
              </div>
              <div className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                {call.guest_name ? `Guest: ${call.guest_name}` : call.summary || "Tap for transcript"}
              </div>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
