import { NextResponse } from "next/server";

const COMPOSIO_BASE =
  process.env.COMPOSIO_API_BASE || "https://backend.composio.dev/api/v3";
const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const API_SECRET = process.env.FLOOM_API_SECRET || "";

type JsonObject = Record<string, unknown>;
type LocalIdValidation =
  | { ok: true; ids: Set<string> }
  | { ok: false; response: NextResponse };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const decodedId = decodeURIComponent(id);

  // Verify the composio_connection_id exists in local composio_connections table
  const localIds = await fetchLocalComposioConnectionIds();
  if (!localIds.ok) return localIds.response;
  if (!localIds.ids.has(decodedId)) {
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

async function fetchLocalComposioConnectionIds(): Promise<LocalIdValidation> {
  if (!API_SECRET) return ownershipUnavailable();
  try {
    const res = await fetch(`${API_BASE}/connections`, {
      headers: { "x-floom-secret": API_SECRET, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return ownershipUnavailable();
    const list = (await res.json()) as { composio_connection_id?: string }[];
    if (!Array.isArray(list)) return ownershipUnavailable();
    return {
      ok: true,
      ids: new Set(
        list
          .map((item) => item.composio_connection_id)
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      ),
    };
  } catch {
    return ownershipUnavailable();
  }
}

function ownershipUnavailable(): LocalIdValidation {
  return {
    ok: false,
    response: NextResponse.json(
      { error: "Cannot verify ownership: backend unavailable" },
      { status: 503 }
    ),
  };
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
