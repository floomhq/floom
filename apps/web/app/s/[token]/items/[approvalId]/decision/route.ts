import { NextRequest, NextResponse } from "next/server";

const API_BASE = process.env.FLOOM_API_BASE || "https://localhost:8000";
const API_SECRET = process.env.FLOOM_API_SECRET || "";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; approvalId: string }> },
) {
  const { token, approvalId } = await params;
  const body = await request.text();
  const headers = new Headers({
    "content-type": request.headers.get("content-type") || "application/json",
  });
  if (API_SECRET) headers.set("x-floom-secret", API_SECRET);

  const upstream = await fetch(
    `${API_BASE}/approvals/public-batch/${encodeURIComponent(token)}/items/${encodeURIComponent(approvalId)}/decision`,
    {
      method: "POST",
      headers,
      body,
      cache: "no-store",
    },
  );

  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Robots-Tag", "noindex, nofollow");

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
