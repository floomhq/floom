import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "@/lib/api-server";

// Record a hire (auth). Provisioning itself is handled by the worker-create
// path; this records that the user hired a marketplace item.
export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await apiFetch(`/marketplace/hires`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const data = res.ok ? await res.json() : { error: await res.text() };
  return NextResponse.json(data, { status: res.status });
}
