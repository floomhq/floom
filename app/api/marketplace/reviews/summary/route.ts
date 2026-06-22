import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "@/lib/api-server";

// Public-safe aggregate ratings: { "worker:first_party:slug": {avg, count} }.
export async function GET(req: NextRequest) {
  const items = req.nextUrl.searchParams.get("items") ?? "";
  const res = await apiFetch(`/marketplace/reviews/summary?items=${encodeURIComponent(items)}`);
  const data = res.ok ? await res.json() : {};
  return NextResponse.json(data);
}
