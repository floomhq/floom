import { NextRequest, NextResponse } from "next/server";
import { forwardSecureSetCookies } from "@/lib/secure-set-cookie";

const API_BASE =
  process.env.WORKEROS_API_BASE ||
  process.env.NEXT_PUBLIC_WORKEROS_API_BASE ||
  "https://workeros-api.floom.dev";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const mode = typeof body.mode === "string" ? body.mode : "signin";
  const path = mode === "signup" ? "/auth/password-signup" : "/auth/password-login";
  const upstream = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const payload = await upstream.json().catch(() => ({}));
  const response = NextResponse.json(payload, { status: upstream.status });
  forwardSecureSetCookies(upstream, response.headers);
  return response;
}
