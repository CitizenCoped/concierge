import { notify } from "@/lib/notify";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  await notify({
    event: "system.test",
    message: "Test notification from Settings — everything is wired up! 🎉",
  });
  return Response.json({ ok: true });
}
