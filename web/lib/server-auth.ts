// Server-only auth probe for public, logged-out-reachable pages.
//
// The public share surfaces (/s/* and /w/*) render without the app sidebar and
// are reachable WITHOUT a session (see middleware.ts PUBLIC_PAGE_PREFIXES). But
// a *signed-in* visitor who opens a share link should be offered a way back to
// their dashboard rather than being pushed at "Sign in" / "Add to workspace"
// → /login (FL4). This helper lets those server components detect the session
// the same way middleware.ts does, so the share-card CTAs can branch on it.
//
// Mirrors middleware.ts: a valid cloud Supabase session cookie counts as
// authenticated. This file is cloud-owned; OSS HMAC cookies are intentionally
// not accepted here.
import { cookies } from "next/headers";
import { verifySession } from "@/lib/verify-session";

const SESSION_COOKIE = "workeros_cloud_session";

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return Boolean(await verifySession(token));
}
