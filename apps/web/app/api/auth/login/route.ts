import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  deriveSessionToken,
  isCorrectSecret,
} from "@/lib/web-session";
import { forwardSecureSetCookies } from "@/lib/secure-set-cookie";

const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

// #923: secret-mode logins were brute-forceable — the backend rate-limits
// /auth/login (username/password), but the legacy secret check happens
// entirely in this route. Mirror the backend policy: 5 failures per IP per
// 15-minute window. Per-instance memory is a deliberate trade-off on
// serverless; it still throttles sustained single-instance brute force.
const FAILED_WINDOW_MS = 15 * 60 * 1000;
const FAILED_THRESHOLD = 5;
const failedSecretAttempts = new Map<string, number[]>();

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

function secretLoginLockedOut(ip: string): boolean {
  const cutoff = Date.now() - FAILED_WINDOW_MS;
  const attempts = (failedSecretAttempts.get(ip) || []).filter((t) => t > cutoff);
  failedSecretAttempts.set(ip, attempts);
  return attempts.length >= FAILED_THRESHOLD;
}

function recordFailedSecretLogin(ip: string): void {
  const attempts = failedSecretAttempts.get(ip) || [];
  attempts.push(Date.now());
  failedSecretAttempts.set(ip, attempts);
}

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
    // #944: malformed JSON used to fall through to the secret-mode check and
    // surface a 401 "Invalid access secret." — a parse error is a 400, and
    // internal auth-mode names stay out of public responses.
    return NextResponse.json({ detail: "Invalid request body" }, { status: 400 });
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
      headers: {
        "content-type": "application/json",
        // #941: auth responses are identity-bearing — never shared-cacheable
        "cache-control": "private, no-store, max-age=0",
      },
    });
    // Forward the wos_session cookie from the backend (#927: force Secure)
    forwardSecureSetCookies(upstream, res.headers);
    return res;
  }

  // Legacy single-user flow: secret
  const ip = clientIp(req);
  if (secretLoginLockedOut(ip)) {
    return NextResponse.json(
      { detail: "too many failed login attempts; try again later" },
      { status: 429 },
    );
  }
  const secret = typeof body.secret === "string" ? body.secret : "";
  if (!isCorrectSecret(secret)) {
    recordFailedSecretLogin(ip);
    // #944: one generic credential-failure message across both login modes.
    return NextResponse.json({ detail: "invalid credentials" }, { status: 401 });
  }
  failedSecretAttempts.delete(ip);

  const token = await deriveSessionToken();
  const res = NextResponse.json({ ok: true });
  res.headers.set("cache-control", "private, no-store, max-age=0"); // #941
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return res;
}
