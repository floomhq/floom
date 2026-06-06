import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  deriveSessionToken,
  isCorrectSecret,
} from "@/lib/web-session";

const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * POST /api/auth/login
 *
 * Supports two login modes:
 *
 * 1. Legacy single-user mode (FLOOM_API_SECRET set):
 *    Body: { secret: string }
 *    Verifies against FLOOM_API_SECRET, sets HMAC web-session cookie.
 *
 * 2. Multi-member mode (username + password):
 *    Body: { username: string; password: string }
 *    Proxies to backend /auth/login, which sets a wos_session cookie.
 *    The middleware accepts wos_session as valid auth.
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") || "";
  let body: Record<string, unknown> = {};
  try {
    if (contentType.includes("application/json")) {
      body = (await req.json()) as Record<string, unknown>;
    } else {
      const form = await req.formData();
      for (const [key, value] of form.entries()) {
        body[key] = value;
      }
    }
  } catch {
    body = {};
  }

  // Multi-member flow: username + password
  if (typeof body.username === "string") {
    const upstream = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: body.username, password: body.password ?? "" }),
    });
    const upstreamBody = await upstream.text();
    const res = new NextResponse(upstreamBody, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
    // Forward the wos_session cookie from the backend
    const setCookie = upstream.headers.get("set-cookie");
    if (setCookie) {
      res.headers.set("set-cookie", setCookie);
    }
    return res;
  }

  // Legacy single-user flow: secret
  const secret = typeof body.secret === "string" ? body.secret : "";
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
