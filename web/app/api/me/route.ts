import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, parseCurrentUser } from "../../lib/me";
import { verifySession } from "@/lib/verify-session";

// Optional arg: the cloud me-cache-941 test calls GET() with no args, while the
// engine's auth-route-cache-headers-941 test (synced in, runs against this route)
// calls GET(req). Optional satisfies both without changing behavior.
export async function GET(_req?: Request) {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  // #935: only present a user when the session JWT signature verifies (when
  // Supabase is configured) — a forged cookie must not produce a fake user.
  const session = await verifySession(raw);
  const user = session ? parseCurrentUser(raw) : null;
  return NextResponse.json(
    { user },
    {
      status: 200,
      // #941: identity/role JSON must never land in a shared cache (Vercel
      // served this with `public, max-age=0, must-revalidate` otherwise).
      headers: { "cache-control": "private, no-store, max-age=0" },
    },
  );
}
