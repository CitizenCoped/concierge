import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { fmtLocal } from "@/lib/time";
import { OUTCOME_BADGES } from "@/lib/outcomes";

export const dynamic = "force-dynamic";

interface Turn {
  id: number;
  role: "caller" | "agent";
  text: string;
  at: string;
}

export default async function CallDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const calls = (await db()`
    select c.*, g.name as guest_name
    from calls c
    left join guests g on g.id = c.matched_guest_id
    where c.id = ${id}::uuid`) as Array<{
    id: string;
    started_at: string | null;
    ended_at: string | null;
    from_number: string | null;
    outcome: string | null;
    summary: string | null;
    guest_name: string | null;
  }>;
  const call = calls[0];
  if (!call) notFound();

  const turns = (await db()`
    select id, role, text, at from call_turns
    where call_id = ${id}::uuid
    order by id asc`) as Turn[];

  const messages = (await db()`
    select body, taken_at from messages
    where call_id = ${id}::uuid
    order by taken_at asc`) as Array<{ body: string; taken_at: string }>;

  const badge = OUTCOME_BADGES[call.outcome ?? ""] ?? OUTCOME_BADGES.hangup;

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <Link href="/calls" className="text-sm text-blue-600 dark:text-blue-400">
          ← All calls
        </Link>
        <div className="mt-2 flex items-center justify-between gap-2">
          <h1 className="text-xl font-bold">
            {call.started_at ? fmtLocal(call.started_at) : "Call"}
          </h1>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
            {badge.label}
          </span>
        </div>
        <div className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {call.from_number && <div>From {call.from_number}</div>}
          {call.guest_name && <div>Matched guest: {call.guest_name}</div>}
          {call.summary && <div className="mt-1">{call.summary}</div>}
        </div>
      </header>

      {messages.length > 0 && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            📝 Message taken
          </h2>
          {messages.map((m, i) => (
            <p key={i} className="mt-1 text-sm">
              {m.body}
            </p>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Transcript
        </h2>
        {turns.length === 0 && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No transcript recorded.
          </p>
        )}
        {turns.map((turn) => (
          <div
            key={turn.id}
            className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
              turn.role === "agent"
                ? "self-end rounded-br-md bg-blue-600 text-white"
                : "self-start rounded-bl-md bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
            }`}
          >
            <div className="mb-0.5 text-[10px] font-semibold uppercase opacity-70">
              {turn.role === "agent" ? "Concierge AI" : "Front desk"}
            </div>
            {turn.text}
          </div>
        ))}
      </section>
    </main>
  );
}
