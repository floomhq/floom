import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const API_BASE =
  process.env.WORKEROS_API_BASE || "https://workeros-api.floom.dev";
const SESSION_COOKIE = "workeros_cloud_session";
const ACTIVE_WORKSPACE_COOKIE = "workeros_active_workspace";

function normalizeCookieValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function decodeBase64Url(value: string): string {
  value = normalizeCookieValue(value);
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const cookieStore = await cookies();
  const rawSession = cookieStore.get(SESSION_COOKIE)?.value;
  if (!rawSession) return null;

  const payload = JSON.parse(decodeBase64Url(rawSession)) as { access_token?: string };
  if (!payload.access_token) return null;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    Authorization: `Bearer ${payload.access_token}`,
  };
  const activeWorkspace = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  if (activeWorkspace) {
    headers["x-workeros-workspace"] = activeWorkspace;
  }
  return headers;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const composioConnId = decodeURIComponent(id);
  const headers = await authHeaders();
  if (!headers) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const localId = await resolveLocalConnectionId(composioConnId, headers);
  if (!localId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const upstream = await fetch(
      `${API_BASE}/api/connections/${encodeURIComponent(localId)}/account-info`,
      { headers, cache: "no-store" }
    );
    if (!upstream.ok) {
      if (upstream.status === 404) {
        return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      }
      if (upstream.status === 503) {
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
      connected_at: body["connected_at"] ?? undefined,
    });
  } catch {
    return NextResponse.json({ id: composioConnId, scopes: [] }, { status: 200 });
  }
}

async function resolveLocalConnectionId(
  composioConnId: string,
  headers: Record<string, string>
): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/connections`, {
      headers,
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
