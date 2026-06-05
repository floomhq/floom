import { NextRequest, NextResponse } from "next/server";

const API_BASE = process.env.WORKEROS_API_BASE || "https://workeros-api.floom.dev";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const upstream = await fetch(`${API_BASE}/api/s/${encodeURIComponent(token)}/download`, {
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
