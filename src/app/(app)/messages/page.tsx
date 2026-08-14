import Link from "next/link";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { fmtLocal } from "@/lib/time";

export const dynamic = "force-dynamic";

interface MessageRow {
  id: string;
  call_id: string | null;
  body: string;
  taken_at: string;
  read_at: string | null;
}

async function toggleRead(formData: FormData): Promise<void> {
  "use server";
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await db()`
    update messages
    set read_at = case when read_at is null then now() else null end
    where id = ${id}::uuid`;
  revalidatePath("/messages");
}

export default async function MessagesPage() {
  const messages = (await db()`
    select id, call_id, body, taken_at, read_at
    from messages
    order by taken_at desc
    limit 200`) as MessageRow[];
  const unread = messages.filter((m) => !m.read_at).length;

  return (
    <main className="flex flex-col gap-4 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-bold">📝 Messages</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {unread > 0 ? `${unread} unread` : "All caught up"}
        </p>
      </header>
      {messages.length === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          No messages taken yet.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-2xl border p-4 ${
              m.read_at
                ? "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
                : "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/40"
            }`}
          >
            <div className="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span>{fmtLocal(m.taken_at)}</span>
              {!m.read_at && (
                <span className="h-2.5 w-2.5 rounded-full bg-blue-600" aria-label="unread" />
              )}
            </div>
            <p className={`mt-1 text-sm ${m.read_at ? "" : "font-medium"}`}>
              {m.body}
            </p>
            <div className="mt-3 flex items-center gap-3">
              <form action={toggleRead}>
                <input type="hidden" name="id" value={m.id} />
                <button className="text-sm font-medium text-blue-600 dark:text-blue-400">
                  Mark {m.read_at ? "unread" : "read"}
                </button>
              </form>
              {m.call_id && (
                <Link
                  href={`/calls/${m.call_id}`}
                  className="text-sm text-neutral-500 dark:text-neutral-400"
                >
                  View call →
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
