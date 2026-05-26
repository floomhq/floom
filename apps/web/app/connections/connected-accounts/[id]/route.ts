import { NextRequest, NextResponse } from "next/server";

const COMPOSIO_BASE =
  process.env.COMPOSIO_API_BASE || "https://backend.composio.dev/api/v3";
const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const API_SECRET = process.env.FLOOM_API_SECRET || "";
const COMPOSIO_ROUTE_SECRET = process.env.WORKEROS_API_SECRET || API_SECRET;

type JsonObject = Record<string, unknown>;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth gate: require x-floom-secret when WORKEROS_API_SECRET (or FLOOM_API_SECRET) is set.
  // When neither is configured (local dev with no secret), allow through.
  if (COMPOSIO_ROUTE_SECRET) {
    const incomingSecret = request.headers.get("x-floom-secret") ?? "";
    if (incomingSecret !== COMPOSIO_ROUTE_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const { id } = await params;
  const decodedId = decodeURIComponent(id);

  // Verify the composio_connection_id exists in local composio_connections table
  const localIds = await fetchLocalComposioConnectionIds();
  if (localIds !== null && !localIds.has(decodedId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const key = process.env.COMPOSIO_API_KEY || "";
  if (!key) {
    return NextResponse.json(
      { error: "Composio not configured" },
      { status: 503 }
    );
  }

  const response = await fetch(
    `${COMPOSIO_BASE}/connected_accounts/${encodeURIComponent(decodedId)}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const status = response.status;
    if (status === 401 || status === 403) {
      return NextResponse.json(
        { error: "Composio authentication failed" },
        { status }
      );
    }
    if (status === 404) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    if (status === 429) {
      return NextResponse.json(
        { error: "Composio rate limit exceeded" },
        { status: 429 }
      );
    }
    if (status >= 500) {
      return NextResponse.json(
        { error: "Composio service unavailable" },
        { status: 502 }
      );
    }
    return NextResponse.json({ id: decodedId, scopes: [] }, { status: 200 });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return NextResponse.json({ id: decodedId, scopes: [] });
  }

  const account = getNestedObject(body, ["connected_account"]) ?? asObject(body);
  return NextResponse.json({
    id: getNestedString(account, ["id"]) || decodedId,
    auth_config_id:
      getNestedString(account, ["auth_config", "id"]) ||
      getNestedString(account, ["authConfig", "id"]) ||
      getNestedString(account, ["auth_config_id"]),
    email: extractEmail(account),
    scopes: extractStringArray(account, ["scopes"]),
    user_id: getNestedString(account, ["user_id"]) || getNestedString(account, ["userId"]),
  });
}

/**
 * Fetch the set of composio_connection_ids from the local backend DB.
 * Returns null if the backend is unreachable (fail open to avoid breaking the page).
 */
async function fetchLocalComposioConnectionIds(): Promise<Set<string> | null> {
  if (!API_SECRET) return null; // dev mode: skip validation
  try {
    const res = await fetch(`${API_BASE}/connections`, {
      headers: { "x-floom-secret": API_SECRET, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const list = (await res.json()) as { composio_connection_id?: string }[];
    if (!Array.isArray(list)) return null;
    return new Set(
      list
        .map((item) => item.composio_connection_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    );
  } catch {
    return null; // backend unreachable: fail open
  }
}

function extractEmail(account: JsonObject | undefined) {
  return (
    getNestedString(account, ["email"]) ||
    getNestedString(account, ["account_email"]) ||
    getNestedString(account, ["data", "email"]) ||
    getNestedString(account, ["user", "email"]) ||
    getNestedString(account, ["profile", "email"]) ||
    getNestedString(account, ["connection_data", "email"]) ||
    getNestedString(account, ["connectionData", "email"]) ||
    getNestedString(account, ["metadata", "email"])
  );
}

function extractStringArray(value: unknown, path: string[]) {
  const array = getNestedArray(value, path);
  return array.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function getNestedObject(value: unknown, path: string[]): JsonObject | undefined {
  return asObject(
    path.reduce<unknown>((acc, key) => {
      if (!acc || typeof acc !== "object" || Array.isArray(acc)) return undefined;
      return (acc as JsonObject)[key];
    }, value)
  );
}

function getNestedArray(value: unknown, path: string[]) {
  const current = path.reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || Array.isArray(acc)) return undefined;
    return (acc as JsonObject)[key];
  }, value);
  return Array.isArray(current) ? current : [];
}

function getNestedString(value: unknown, path: string[]) {
  const current = path.reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || Array.isArray(acc)) return undefined;
    return (acc as JsonObject)[key];
  }, value);
  return typeof current === "string" ? current : undefined;
}
