import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, expectedToken, timingSafeEqualStr } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const cookie = req.cookies.get(AUTH_COOKIE)?.value ?? "";
  const expected = await expectedToken();
  if (cookie && timingSafeEqualStr(cookie, expected)) {
    return NextResponse.next();
  }
  if (req.nextUrl.pathname.startsWith("/api")) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

// Everything requires the passphrase cookie except: login, the AgentPhone
// webhook, and public PWA plumbing (manifest, service worker, icons, statics).
export const config = {
  matcher: [
    "/((?!login|api/login|api/agentphone/webhook|_next|favicon\\.ico|manifest\\.webmanifest|sw\\.js|icons/).*)",
  ],
};
