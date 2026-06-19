// #821 — lightweight session presence for the landing nav CTA.
//
// The session cookie (workeros_cloud_session, set on .floom.dev by the
// backend auth callback) is HttpOnly AND encrypted ("v2." + Fernet
// ciphertext, minted by apps/api/routes/auth.py _encode_session_cookie), so
// the landing cannot decode it in TS without duplicating the Fernet secret.
//
// Instead we ask the backend to validate it: the existing GET /auth/session-token
// endpoint decodes the cookie, refreshes if needed, and returns 200 with an
// access token for a valid session or 401 for a missing/garbage/expired one.
// We forward the incoming cookie and report authed:true only on a 200.
// Display-only: no token leaves this route.

import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "workeros_cloud_session";

const API_BASE =
  process.env.WORKEROS_API_BASE ||
  process.env.NEXT_PUBLIC_WORKEROS_API_BASE ||
  "https://workeros-api.floom.dev";

export async function GET(req: NextRequest) {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) {
    return NextResponse.json(
      { authed: false },
      { headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  }

  let authed = false;
  try {
    const upstream = await fetch(`${API_BASE}/auth/session-token`, {
      method: "GET",
      headers: { cookie: `${SESSION_COOKIE}=${raw}` },
      cache: "no-store",
    });
    authed = upstream.ok;
  } catch {
    authed = false;
  }

  return NextResponse.json(
    { authed },
    { headers: { "cache-control": "private, no-store, max-age=0" } },
  );
}
