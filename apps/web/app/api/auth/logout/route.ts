import { NextRequest, NextResponse } from "next/server";
import { secureCookiesForUrl } from "@/lib/secure-set-cookie";
import { SESSION_COOKIE } from "@/lib/web-session";

const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";

/** POST /api/auth/logout — clears both the web session and backend session cookies. */
export async function POST(req: NextRequest) {
  // Call the backend to invalidate the server-side session
  const backendSession = req.cookies.get("wos_session")?.value;
  if (backendSession) {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers: {
          cookie: `wos_session=${backendSession}`,
          "content-type": "application/json",
        },
      });
    } catch {
      // best-effort — still clear the cookie on the client side
    }
  }

  const res = NextResponse.json({ ok: true });
  res.headers.set("cache-control", "private, no-store, max-age=0"); // #941
  const secureCookies = secureCookiesForUrl(req.url);
  // Clear the Next.js web session cookie
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  // Clear the backend session cookie (#927: Secure matches how it is set)
  res.cookies.set("wos_session", "", {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
