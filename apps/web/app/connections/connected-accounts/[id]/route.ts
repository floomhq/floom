import { NextResponse } from "next/server";

const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const API_SECRET = process.env.FLOOM_API_SECRET || "";

/**
 * Proxy GET /connections/connected-accounts/:id to the FastAPI service.
 *
 * The Composio API key lives on the FastAPI service, not on Vercel.
 * The FastAPI endpoint GET /connections/:id/account-info handles the Composio call.
 * We accept the composio_connection_id (UUID) and look it up via GET /connections
 * to find the local connection id, then forward to account-info.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const composioConnId = decodeURIComponent(id);

  if (!API_SECRET) {
    return NextResponse.json(
      { error: "Backend not configured" },
      { status: 503 }
    );
  }

  // Look up local connection id by composio_connection_id
  const localId = await resolveLocalConnectionId(composioConnId);
  if (!localId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Forward to FastAPI account-info endpoint
  try {
    const upstream = await fetch(
      `${API_BASE}/connections/${encodeURIComponent(localId)}/account-info`,
      {
        headers: { "x-floom-secret": API_SECRET, "Content-Type": "application/json" },
        cache: "no-store",
      }
    );
    if (!upstream.ok) {
      const status = upstream.status;
      if (status === 404) {
        return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      }
      if (status === 503) {
        return NextResponse.json(
          { error: "Connections backend not configured" },
          { status: 503 }
        );
      }
      return NextResponse.json({ id: composioConnId, scopes: [] }, { status: 200 });
    }
    const body = await upstream.json() as Record<string, unknown>;
    return NextResponse.json({
      id: body["id"] ?? composioConnId,
      email: body["email"] ?? undefined,
      scopes: Array.isArray(body["scopes"]) ? body["scopes"] : [],
      user_id: body["user_id"] ?? undefined,
      auth_config_id: body["auth_config_id"] ?? undefined,
    });
  } catch {
    return NextResponse.json({ id: composioConnId, scopes: [] }, { status: 200 });
  }
}

async function resolveLocalConnectionId(composioConnId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/connections`, {
      headers: { "x-floom-secret": API_SECRET, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const list = (await res.json()) as { id?: string; composio_connection_id?: string }[];
    if (!Array.isArray(list)) return null;
    const match = list.find(
      (item) =>
        typeof item.composio_connection_id === "string" &&
        item.composio_connection_id === composioConnId
    );
    return match?.id ?? null;
  } catch {
    return null;
  }
}
