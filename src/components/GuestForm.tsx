"use client";

import { useRef } from "react";

export interface GuestFormDefaults {
  id?: string;
  name?: string;
  guestInfo?: string;
  guestPhone?: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

const inputCls =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900";

export default function GuestForm({
  action,
  defaults,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  defaults: GuestFormDefaults;
  submitLabel: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      action={async (fd) => {
        await action(fd);
        if (!defaults.id) formRef.current?.reset();
      }}
      className="flex flex-col gap-3"
    >
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <label className="flex flex-col gap-1 text-sm font-medium">
        Name
        <input
          name="name"
          required
          defaultValue={defaults.name ?? ""}
          placeholder="Guest's full name"
          className={inputCls}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Start date
          <input
            type="date"
            name="start_date"
            required
            defaultValue={defaults.startDate}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Start time
          <input
            type="time"
            name="start_time"
            required
            defaultValue={defaults.startTime}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          End date
          <input
            type="date"
            name="end_date"
            required
            defaultValue={defaults.endDate}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          End time
          <input
            type="time"
            name="end_time"
            required
            defaultValue={defaults.endTime}
            className={inputCls}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Guest info
        <textarea
          name="guest_info"
          rows={2}
          defaultValue={defaults.guestInfo ?? ""}
          placeholder="Purpose, unit notes, deliveries…"
          className={inputCls}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Guest phone (optional)
        <input
          type="tel"
          name="guest_phone"
          defaultValue={defaults.guestPhone ?? ""}
          placeholder="+1 619 555 0100"
          className={inputCls}
        />
      </label>
      <button
        type="submit"
        className="rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white active:bg-blue-700"
      >
        {submitLabel}
      </button>
    </form>
  );
}
