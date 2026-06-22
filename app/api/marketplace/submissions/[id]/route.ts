import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "@/lib/api-server";

// Moderate a submission (approve/reject/archive). Backend gates to moderators.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.text();
  const res = await apiFetch(`/marketplace/submissions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body,
  });
  const data = res.ok ? await res.json() : { error: await res.text() };
  return NextResponse.json(data, { status: res.status });
}
