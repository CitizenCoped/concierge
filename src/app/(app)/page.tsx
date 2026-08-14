import { db } from "@/lib/db";
import type { Guest } from "@/lib/db/guests";
import {
  addGuest,
  archiveGuest,
  extendGuest,
  updateGuest,
} from "@/app/actions/guests";
import GuestForm from "@/components/GuestForm";
import { defaultStart, fmtLocal, timeRemaining, toLocalInput } from "@/lib/time";

export const dynamic = "force-dynamic";

function Chip({ children, tone }: { children: React.ReactNode; tone: "green" | "amber" | "gray" }) {
  const tones = {
    green:
      "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300",
    amber:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
    gray: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  } as const;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function GuestCard({ guest, status }: { guest: Guest; status: "active" | "upcoming" | "past" }) {
  const start = toLocalInput(guest.starts_at);
  const end = toLocalInput(guest.ends_at);
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{guest.name}</div>
          <div className="text-sm text-neutral-500 dark:text-neutral-400">
            {fmtLocal(guest.starts_at)} → {fmtLocal(guest.ends_at)}
          </div>
        </div>
        {status === "active" && <Chip tone="green">{timeRemaining(guest.ends_at)}</Chip>}
        {status === "upcoming" && <Chip tone="amber">upcoming</Chip>}
        {status === "past" && <Chip tone="gray">ended</Chip>}
      </div>
      {guest.guest_info && (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
          {guest.guest_info}
        </p>
      )}
      {guest.guest_phone && (
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          📱 {guest.guest_phone}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <form action={extendGuest}>
          <input type="hidden" name="id" value={guest.id} />
          <button className="rounded-lg bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            +2h
          </button>
        </form>
        <form action={archiveGuest}>
          <input type="hidden" name="id" value={guest.id} />
          <button className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            Archive
          </button>
        </form>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-sm font-medium text-blue-600 dark:text-blue-400">
          Edit
        </summary>
        <div className="mt-3">
          <GuestForm
            action={updateGuest}
            submitLabel="Save changes"
            defaults={{
              id: guest.id,
              name: guest.name,
              guestInfo: guest.guest_info ?? "",
              guestPhone: guest.guest_phone ?? "",
              startDate: start.date,
              startTime: start.time,
              endDate: end.date,
              endTime: end.time,
            }}
          />
        </div>
      </details>
    </div>
  );
}

export default async function GuestsPage() {
  const guests = (await db()`
    select * from guests
    where archived = false
      and ends_at > now() - interval '7 days'
    order by starts_at asc`) as Guest[];

  const now = Date.now();
  const active = guests.filter(
    (g) => new Date(g.starts_at).getTime() <= now && new Date(g.ends_at).getTime() >= now
  );
  const upcoming = guests.filter((g) => new Date(g.starts_at).getTime() > now);
  const past = guests
    .filter((g) => new Date(g.ends_at).getTime() < now)
    .reverse();

  const start = defaultStart();
  const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const startInput = toLocalInput(start);
  const endInput = toLocalInput(end);

  return (
    <main className="flex flex-col gap-6 p-4">
      <header className="pt-2">
        <h1 className="text-2xl font-bold">🔔 Guest List</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Who the front desk may send up
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Active now ({active.length})
        </h2>
        {active.length === 0 && (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No active guests — visitors will be transferred to you.
          </p>
        )}
        {active.map((g) => (
          <GuestCard key={g.id} guest={g} status="active" />
        ))}
      </section>

      {upcoming.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Upcoming ({upcoming.length})
          </h2>
          {upcoming.map((g) => (
            <GuestCard key={g.id} guest={g} status="upcoming" />
          ))}
        </section>
      )}

      <section className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="font-semibold">Add a guest</h2>
        <GuestForm
          action={addGuest}
          submitLabel="Add guest"
          defaults={{
            startDate: startInput.date,
            startTime: startInput.time,
            endDate: endInput.date,
            endTime: endInput.time,
          }}
        />
      </section>

      {past.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Recently ended
          </h2>
          {past.map((g) => (
            <GuestCard key={g.id} guest={g} status="past" />
          ))}
        </section>
      )}
    </main>
  );
}
