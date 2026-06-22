import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "@/lib/api-server";

// Public list of APPROVED community items (display-safe payloads only).
export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("item_kind");
  const q = kind ? `?item_kind=${encodeURIComponent(kind)}` : "";
  const res = await apiFetch(`/marketplace/community${q}`);
  const data = res.ok ? await res.json() : { items: [] };
  return NextResponse.json(data);
}
