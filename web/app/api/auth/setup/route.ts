import { NextRequest, NextResponse } from "next/server";
import { forwardSecureSetCookies } from "@/lib/secure-set-cookie";

const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const UPSTREAM_TIMEOUT_MS = 10_000;

async function fetchSetupUpstream(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function setupProxyError(): NextResponse {
  return NextResponse.json(
    {
      detail: "Setup service unavailable.",
      upstream: API_BASE,
    },
    {
      status: 502,
      headers: { "cache-control": "private, no-store, max-age=0" },
    },
  );
}

/**
 * POST /api/auth/setup
 * Body: { username: string; password: string; display_name?: string }
 *
 * Proxies to the backend /auth/setup endpoint. On success, the backend sets a
 * wos_session cookie that the middleware accepts as valid auth.
 */
export async function GET(_req: NextRequest) {
  // Proxy GET /auth/setup-required to the backend
  try {
    const upstream = await fetchSetupUpstream("/auth/setup-required", {
      headers: { "x-floom-secret": process.env.FLOOM_API_SECRET || "" },
    });
    const body = await upstream.json();
    return NextResponse.json(body, {
      status: upstream.status,
      headers: { "cache-control": "private, no-store, max-age=0" }, // #941
    });
  } catch {
    return setupProxyError();
  }
}

export async function POST(req: NextRequest) {
  const body = await req.arrayBuffer();
  let upstream: Response;
  try {
    upstream = await fetchSetupUpstream("/auth/setup", {
      method: "POST",
      headers: {
        "content-type": req.headers.get("content-type") || "application/json",
      },
      body,
    });
  } catch {
    return setupProxyError();
  }

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
  forwardSecureSetCookies(upstream, res.headers);
  return res;
}
