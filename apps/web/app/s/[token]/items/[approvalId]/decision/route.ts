import { NextRequest, NextResponse } from "next/server";

// Public route: do NOT forward FLOOM_API_SECRET. The upstream
// /approvals/public-batch/{token}/items/{id}/decision is middleware-exempt
// (token-gated by the share token), so the privileged secret must not leak here (#1966 hardening).

function getApiBase(): string | null {
  const apiBase = process.env.FLOOM_API_BASE?.trim();
  return apiBase ? apiBase.replace(/\/$/, "") : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; approvalId: string }> },
) {
  const { token, approvalId } = await params;
  const apiBase = getApiBase();
  if (!apiBase) {
    return NextResponse.json(
      { detail: "FLOOM_API_BASE is required for public approval decisions." },
      { status: 503, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } },
    );
  }
  const body = await request.text();
  const headers = new Headers({
    "content-type": request.headers.get("content-type") || "application/json",
  });

  const upstream = await fetch(
    `${apiBase}/approvals/public-batch/${encodeURIComponent(token)}/items/${encodeURIComponent(approvalId)}/decision`,
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
