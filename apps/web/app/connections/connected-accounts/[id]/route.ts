import { NextResponse } from "next/server";

const API_BASE = process.env.FLOOM_API_BASE || "https://localhost:8000";
const API_SECRET = process.env.FLOOM_API_SECRET || "";

/**
 * Proxy GET /connections/connected-accounts/:id to the FastAPI service.
 *
 * The Composio API key lives on the FastAPI service, not on Vercel.
 * The FastAPI endpoint GET /connections/:id/account-info handles the Composio call.
 * We accept the internal Floom connection id (NEW-7, 2026-06-02: the raw Composio
 * `ca_*` id is no longer exposed) and validate it via GET /connections before
 * forwarding to account-info.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const connectionId = decodeURIComponent(id);

  if (!API_SECRET) {
    return NextResponse.json(
      { error: "Backend not configured" },
      { status: 503 }
    );
  }

  // Validate the internal connection id exists for this workspace.
  const localId = await resolveLocalConnectionId(connectionId);
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
      return NextResponse.json({ id: connectionId, scopes: [] }, { status: 200 });
    }
    const body = await upstream.json() as Record<string, unknown>;
    return NextResponse.json({
      id: body["id"] ?? connectionId,
      email: body["email"] ?? undefined,
      scopes: Array.isArray(body["scopes"]) ? body["scopes"] : [],
      connected_at: body["connected_at"] ?? undefined,
    });
  } catch {
    return NextResponse.json({ id: connectionId, scopes: [] }, { status: 200 });
  }
}

async function resolveLocalConnectionId(connectionId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/connections`, {
      headers: { "x-floom-secret": API_SECRET, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const list = (await res.json()) as { id?: string }[];
    if (!Array.isArray(list)) return null;
    const match = list.find(
      (item) => typeof item.id === "string" && item.id === connectionId
    );
    return match?.id ?? null;
  } catch {
    return null;
  }
}
