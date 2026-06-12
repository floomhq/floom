// #821 — lightweight session presence for the landing nav CTA.
//
// The session cookie (workeros_cloud_session, set on .floom.dev by the
// backend auth callback) is HttpOnly, so the client cannot inspect it. The
// nav fetches this endpoint non-blockingly after paint and swaps "Sign in"
// for "Dashboard" when a structurally valid, unexpired session is present.
// Display-only: no signature verification here — the dashboard middleware
// (web/) verifies the JWT before anything sensitive renders.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const SESSION_COOKIE = "workeros_cloud_session";

function hasUsableSession(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const value = raw.trim().replace(/^"|"$/g, "");
    const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
    const decoded = Buffer.from(
      padded.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
    const payload = JSON.parse(decoded) as {
      access_token?: unknown;
      expires_at?: unknown;
    };
    if (typeof payload.access_token !== "string" || !payload.access_token) return false;
    const expiresAt = Number(payload.expires_at);
    return Number.isFinite(expiresAt) && expiresAt > Math.floor(Date.now() / 1000) + 30;
  } catch {
    return false;
  }
}

export async function GET() {
  const cookieStore = await cookies();
  const authed = hasUsableSession(cookieStore.get(SESSION_COOKIE)?.value);
  return NextResponse.json(
    { authed },
    { headers: { "cache-control": "private, no-store, max-age=0" } },
  );
}
