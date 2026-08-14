import { NextResponse } from "next/server";
import { AUTH_COOKIE, expectedToken, timingSafeEqualStr } from "@/lib/auth";

export const runtime = "nodejs";

const MAX_AGE_SECONDS = 180 * 24 * 60 * 60; // 180 days

export async function POST(req: Request): Promise<Response> {
  let passphrase = "";
  try {
    const body = (await req.json()) as { passphrase?: string };
    passphrase = String(body.passphrase ?? "");
  } catch {
    // fall through to the constant-time compare with an empty string
  }
  const expected = process.env.APP_PASSPHRASE ?? "";
  if (!expected || !timingSafeEqualStr(passphrase, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await expectedToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
  return res;
}
