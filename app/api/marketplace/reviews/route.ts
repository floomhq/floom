import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "@/lib/api-server";

// Proxies marketplace review reads/writes to the FastAPI cloud backend, adding
// the caller's Bearer token (POST requires auth; GET is public-safe).
export async function GET(req: NextRequest) {
  const qs = req.nextUrl.searchParams.toString();
  const res = await apiFetch(`/marketplace/reviews?${qs}`);
  const data = res.ok ? await res.json() : { reviews: [] };
  return NextResponse.json(data, { status: res.ok ? 200 : 200 });
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await apiFetch(`/marketplace/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const data = res.ok ? await res.json() : { error: await res.text() };
  return NextResponse.json(data, { status: res.status });
}
