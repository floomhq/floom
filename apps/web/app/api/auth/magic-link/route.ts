import { NextRequest, NextResponse } from "next/server";

const NO_STORE = "private, no-store, max-age=0";

function getApiBase(): string | null {
  const apiBase = process.env.FLOOM_API_BASE?.trim().replace(/\/+$/, "");
  return apiBase || null;
}

export async function POST(req: NextRequest) {
  const apiBase = getApiBase();
  if (!apiBase) {
    return NextResponse.json(
      {
        detail:
          "FLOOM_API_BASE is required for /api/auth/magic-link. Set it to the API origin for this deployment.",
      },
      { status: 503, headers: { "cache-control": NO_STORE } },
    );
  }

  const headers: Record<string, string> = {
    "x-workeros-public-origin": req.nextUrl.origin,
  };
  const backendSession = req.cookies.get("wos_session")?.value;
  if (backendSession) {
    headers.cookie = `wos_session=${backendSession}`;
  }

  const upstream = await fetch(`${apiBase}/auth/magic-link`, {
    method: "POST",
    headers,
  });
  const responseBody = await upstream.text();
  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": NO_STORE,
    },
  });
}
