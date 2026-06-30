import { NextRequest, NextResponse } from "next/server";

function getApiBase(): string | null {
  const apiBase = process.env.FLOOM_API_BASE?.trim();
  return apiBase ? apiBase.replace(/\/$/, "") : null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const apiBase = getApiBase();
  if (!apiBase) {
    return NextResponse.json(
      { detail: "FLOOM_API_BASE is required for public share downloads." },
      { status: 503, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } },
    );
  }

  const upstream = await fetch(`${apiBase}/s/${encodeURIComponent(token)}/download`, {
    headers: { "X-Floom-Source": "web" },
    cache: "no-store",
  });

  const headers = new Headers();
  for (const key of ["content-type", "content-disposition", "content-length"]) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "no-store");

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers,
  });
}
