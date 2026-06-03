import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  deriveSessionToken,
  isCorrectSecret,
} from "@/lib/web-session";

// 30 days. The owner logs in once and stays in; bumping SESSION_MESSAGE in
// lib/web-session.ts (or rotating FLOOM_API_SECRET) invalidates all sessions.
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * POST /api/auth/login
 * Body: { secret: string }  (JSON or form-encoded)
 *
 * Verifies the supplied access secret against FLOOM_API_SECRET. On success,
 * sets an HttpOnly, Secure, SameSite=Lax cookie carrying an HMAC token derived
 * from the secret (never the raw secret). Wrong secret -> 401.
 *
 * Agents can authenticate non-interactively:
 *   curl -i -X POST https://workers.floom.dev/api/auth/login \
 *     -H 'content-type: application/json' \
 *     -d '{"secret":"<FLOOM_API_SECRET>"}'
 * then reuse the returned Set-Cookie on subsequent /api/proxy/* calls.
 */
export async function POST(req: NextRequest) {
  let secret = "";
  const contentType = req.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await req.json()) as { secret?: unknown };
      secret = typeof body.secret === "string" ? body.secret : "";
    } else {
      const form = await req.formData();
      const value = form.get("secret");
      secret = typeof value === "string" ? value : "";
    }
  } catch {
    secret = "";
  }

  if (!isCorrectSecret(secret)) {
    return NextResponse.json({ detail: "Invalid access secret." }, { status: 401 });
  }

  const token = await deriveSessionToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return res;
}
