import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    sub = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return new Response("bad request", { status: 400 });
  }
  await db()`
    insert into push_subscriptions (endpoint, keys)
    values (${sub.endpoint}, ${JSON.stringify(sub.keys)}::jsonb)
    on conflict (endpoint) do update set keys = excluded.keys`;
  return Response.json({ ok: true });
}
