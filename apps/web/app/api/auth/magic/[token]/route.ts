import { NextRequest, NextResponse } from "next/server";
import { forwardSecureSetCookies } from "@/lib/secure-set-cookie";

const NO_STORE = "private, no-store, max-age=0";

function getApiBase(): string | null {
  const apiBase = process.env.FLOOM_API_BASE?.trim().replace(/\/+$/, "");
  return apiBase || null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const apiBase = getApiBase();
  if (!apiBase) {
    return NextResponse.json(
      {
        detail:
          "FLOOM_API_BASE is required for /api/auth/magic/[token]. Set it to the API origin for this deployment.",
      },
      { status: 503, headers: { "cache-control": NO_STORE } },
    );
  }

  const { token } = await params;
  const upstream = await fetch(`${apiBase}/auth/magic/${encodeURIComponent(token)}`, {
    headers: {
      "x-workeros-public-origin": req.nextUrl.origin,
    },
  });
  const responseBody = await upstream.text();
  const res = new NextResponse(responseBody, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": NO_STORE,
    },
  });
  forwardSecureSetCookies(upstream, res.headers);
  return res;
}
