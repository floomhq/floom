import { NextRequest, NextResponse } from "next/server";
import { apiFetch } from "@/lib/api-server";

// POST a community submission (auth). GET lists submissions by status — the
// backend gates non-public statuses to moderators, so this also serves the
// admin moderation queue.
export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await apiFetch(`/marketplace/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const data = res.ok ? await res.json() : { error: await res.text() };
  return NextResponse.json(data, { status: res.status });
}

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? "pending";
  const res = await apiFetch(`/marketplace/submissions?status=${encodeURIComponent(status)}`);
  const data = res.ok ? await res.json() : { submissions: [] };
  return NextResponse.json(data, { status: res.status });
}
