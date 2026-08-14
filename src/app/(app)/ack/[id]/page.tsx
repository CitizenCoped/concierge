import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { fmtLocal } from "@/lib/time";

export const dynamic = "force-dynamic";

async function ackCall(formData: FormData): Promise<void> {
  "use server";
  const id = String(formData.get("id") ?? "");
  const target = String(formData.get("target") ?? "");
  if (!id || (target !== "scott" && target !== "monica")) return;
  await db()`
    insert into call_acks (call_id, target)
    values (${id}::uuid, ${target})
    on conflict (call_id) do update set target = excluded.target`;
  revalidatePath(`/ack/${id}`);
}

export default async function AckPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const calls = (await db()`
    select c.id, c.started_at, c.from_number, c.outcome, a.target as acked
    from calls c
    left join call_acks a on a.call_id = c.id
    where c.id = ${id}::uuid`) as Array<{
    id: string;
    started_at: string | null;
    from_number: string | null;
    outcome: string | null;
    acked: string | null;
  }>;
  const call = calls[0];

  return (
    <main className="flex min-h-[70dvh] flex-col items-center justify-center gap-6 p-6 text-center">
      {!call ? (
        <p>Call not found.</p>
      ) : call.acked ? (
        <>
          <div className="text-5xl">📲</div>
          <h1 className="text-xl font-bold">
            Transferring to {call.acked === "monica" ? "Monica" : "Scott"}
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Your phone will ring in a moment. If the call already moved on to
            message-taking, you can call the front desk back.
          </p>
        </>
      ) : (
        <>
          <div className="text-5xl">📞</div>
          <h1 className="text-xl font-bold">Front desk is holding</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Call started {call.started_at ? fmtLocal(call.started_at) : "just now"}
            {call.from_number ? ` from ${call.from_number}` : ""}. Take it now
            and the concierge AI will transfer the call to your phone.
          </p>
          <div className="flex w-full max-w-xs flex-col gap-3">
            <form action={ackCall}>
              <input type="hidden" name="id" value={call.id} />
              <input type="hidden" name="target" value="scott" />
              <button className="w-full rounded-xl bg-blue-600 px-4 py-3 font-semibold text-white">
                📲 Ring Scott&apos;s phone
              </button>
            </form>
            <form action={ackCall}>
              <input type="hidden" name="id" value={call.id} />
              <input type="hidden" name="target" value="monica" />
              <button className="w-full rounded-xl bg-purple-600 px-4 py-3 font-semibold text-white">
                📲 Ring Monica&apos;s phone
              </button>
            </form>
          </div>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            If nobody taps within ~20 seconds, the AI offers to take a message.
          </p>
        </>
      )}
    </main>
  );
}
