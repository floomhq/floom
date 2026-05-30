import { NextResponse } from "next/server";

/* Waitlist signup endpoint.
 *
 * Inserts an email into public.waitlist using the PUBLIC Supabase anon key
 * via the PostgREST REST endpoint. Both env vars are public/safe:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - NEXT_PUBLIC_SUPABASE_ANON_KEY
 * No service-role secret is used. The waitlist table has an anon INSERT-only
 * RLS policy (see migrations/0009_waitlist.sql), so the anon key can insert
 * but cannot read/update/delete rows.
 *
 * Duplicate email (unique-constraint violation, Postgres 23505) is treated
 * as success: "already on the list" is a good outcome, not an error.
 */

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  let body: { email?: unknown; source?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const source = typeof body.source === "string" ? body.source.slice(0, 64) : "landing";

  if (!email || !EMAIL_RE.test(email) || email.length > 320) {
    return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { ok: false, error: "Waitlist is not configured." },
      { status: 503 },
    );
  }

  let res: Response;
  try {
    res = await fetch(`${supabaseUrl}/rest/v1/waitlist`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
        // Don't ask PostgREST to return the row — anon has no SELECT right,
        // and we don't need the body back.
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ email, source }),
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not reach the waitlist." }, { status: 502 });
  }

  if (res.ok) {
    return NextResponse.json({ ok: true });
  }

  // Duplicate email -> already on the list -> success.
  if (res.status === 409) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const detail = await res.text().catch(() => "");
  if (detail.includes("23505") || detail.toLowerCase().includes("duplicate")) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  return NextResponse.json(
    { ok: false, error: "Could not add you to the list. Try again." },
    { status: 502 },
  );
}
