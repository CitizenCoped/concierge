"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { HOME_TZ } from "@/lib/time";

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function requireWindow(formData: FormData) {
  const startDate = field(formData, "start_date");
  const startTime = field(formData, "start_time");
  const endDate = field(formData, "end_date");
  const endTime = field(formData, "end_time");
  if (!startDate || !startTime || !endDate || !endTime) {
    throw new Error("start and end date/time are required");
  }
  return {
    start: `${startDate} ${startTime}`,
    end: `${endDate} ${endTime}`,
  };
}

export async function addGuest(formData: FormData): Promise<void> {
  const name = field(formData, "name");
  if (!name) throw new Error("name is required");
  const { start, end } = requireWindow(formData);
  const info = field(formData, "guest_info");
  const phone = field(formData, "guest_phone");
  await db()`
    insert into guests (name, guest_info, guest_phone, starts_at, ends_at)
    values (${name}, ${info || null}, ${phone || null},
            (${start}::timestamp at time zone ${HOME_TZ}),
            (${end}::timestamp at time zone ${HOME_TZ}))`;
  revalidatePath("/");
}

export async function updateGuest(formData: FormData): Promise<void> {
  const id = field(formData, "id");
  const name = field(formData, "name");
  if (!id || !name) throw new Error("id and name are required");
  const { start, end } = requireWindow(formData);
  const info = field(formData, "guest_info");
  const phone = field(formData, "guest_phone");
  await db()`
    update guests
    set name = ${name},
        guest_info = ${info || null},
        guest_phone = ${phone || null},
        starts_at = (${start}::timestamp at time zone ${HOME_TZ}),
        ends_at = (${end}::timestamp at time zone ${HOME_TZ}),
        updated_at = now()
    where id = ${id}::uuid`;
  revalidatePath("/");
}

export async function archiveGuest(formData: FormData): Promise<void> {
  const id = field(formData, "id");
  if (!id) return;
  await db()`
    update guests set archived = true, updated_at = now()
    where id = ${id}::uuid`;
  revalidatePath("/");
}

export async function extendGuest(formData: FormData): Promise<void> {
  const id = field(formData, "id");
  if (!id) return;
  await db()`
    update guests
    set ends_at = greatest(ends_at, now()) + interval '2 hours',
        updated_at = now()
    where id = ${id}::uuid`;
  revalidatePath("/");
}
