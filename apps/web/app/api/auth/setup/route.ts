import { NextRequest, NextResponse } from "next/server";
import { forwardSecureSetCookies, secureCookiesForUrl } from "@/lib/secure-set-cookie";

const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";

/**
 * POST /api/auth/setup
 * Body: { username: string; password: string; display_name?: string }
 *
 * Proxies to the backend /auth/setup endpoint. On success, the backend sets a
 * wos_session cookie that the middleware accepts as valid auth.
 */
export async function GET() {
  // Proxy GET /auth/setup-required to the backend
  const upstream = await fetch(`${API_BASE}/auth/setup-required`, {
    headers: { "x-floom-secret": process.env.FLOOM_API_SECRET || "" },
  });
  const body = await upstream.json();
  return NextResponse.json(body, {
    status: upstream.status,
    headers: { "cache-control": "private, no-store, max-age=0" }, // #941
  });
}

export async function POST(req: NextRequest) {
  const body = await req.arrayBuffer();
  const upstream = await fetch(`${API_BASE}/auth/setup`, {
    method: "POST",
    headers: {
      "content-type": req.headers.get("content-type") || "application/json",
    },
    body,
  });

  const responseBody = await upstream.text();
  const res = new NextResponse(responseBody, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "private, no-store, max-age=0", // #941
    },
  });

  // Forward the wos_session cookie from the backend to the browser
  // (#927: force Secure on everything we hand to the browser)
  forwardSecureSetCookies(upstream, res.headers, secureCookiesForUrl(req.url));
  return res;
}
