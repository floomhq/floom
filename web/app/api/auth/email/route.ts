import { NextRequest, NextResponse } from "next/server";
import { safeAppNext } from "@/lib/safe-next";

const API_BASE =
  process.env.WORKEROS_API_BASE ||
  process.env.NEXT_PUBLIC_WORKEROS_API_BASE ||
  "https://workeros-api.floom.dev";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const next = safeAppNext(body.next);
  if (!email) {
    return NextResponse.json({ detail: "email is required" }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const url = new URL(`${API_BASE}/auth/login`);
  url.searchParams.set("provider", "email");
  url.searchParams.set("email", email);
  url.searchParams.set("next", next);

  const upstream = await fetch(url, { method: "GET", cache: "no-store" });
  const payload = await upstream.json().catch(() => ({}));
  return NextResponse.json(payload, { status: upstream.status, headers: NO_STORE_HEADERS });
}
