import { NextResponse } from "next/server";

const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const API_SECRET = process.env.FLOOM_API_SECRET || "";

/**
 * Proxy GET /connections/auth-configs/:id to the FastAPI service.
 *
 * The Composio API key lives on the FastAPI service, not on Vercel.
 * The FastAPI endpoint GET /connections/auth-configs/:id handles the Composio call.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authConfigId = decodeURIComponent(id);

  if (!API_SECRET) {
    return NextResponse.json(
      { error: "Backend not configured" },
      { status: 503 }
    );
  }

  try {
    const upstream = await fetch(
      `${API_BASE}/connections/auth-configs/${encodeURIComponent(authConfigId)}`,
      {
        headers: { "x-floom-secret": API_SECRET, "Content-Type": "application/json" },
        cache: "no-store",
      }
    );
    if (!upstream.ok) {
      const status = upstream.status;
      if (status === 401 || status === 403) {
        return NextResponse.json(
          { error: "Authentication failed" },
          { status }
        );
      }
      if (status === 429) {
        return NextResponse.json({ error: "Rate limited" }, { status: 429 });
      }
      if (status >= 500) {
        return NextResponse.json({ error: "Upstream error" }, { status: 502 });
      }
      return NextResponse.json({ id: authConfigId, scopes: [] }, { status: 200 });
    }
    const body = await upstream.json() as Record<string, unknown>;
    return NextResponse.json({
      id: body["id"] ?? authConfigId,
      scopes: Array.isArray(body["scopes"]) ? body["scopes"] : [],
    });
  } catch {
    return NextResponse.json({ id: authConfigId, scopes: [] }, { status: 200 });
  }
}
