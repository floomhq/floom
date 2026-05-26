import { NextResponse } from "next/server";

const COMPOSIO_BASE =
  process.env.COMPOSIO_API_BASE || "https://backend.composio.dev/api/v3";
const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const API_SECRET = process.env.FLOOM_API_SECRET || "";

type JsonObject = Record<string, unknown>;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const decodedId = decodeURIComponent(id);

  // Verify the auth config id is referenced by at least one local connection
  const validAuthConfigIds = await fetchLocalAuthConfigIds();
  if (validAuthConfigIds !== null && !validAuthConfigIds.has(decodedId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const key = process.env.COMPOSIO_API_KEY || "";
  if (!key) {
    return NextResponse.json(
      { error: "Composio not configured" },
      { status: 503 }
    );
  }

  const direct = await composioGet(`/auth_configs/${encodeURIComponent(decodedId)}`, key);
  let authConfig: unknown;

  if (direct.ok) {
    try {
      authConfig = await direct.json();
    } catch {
      authConfig = undefined;
    }
  } else {
    const status = direct.status;
    if (status === 401 || status === 403) {
      return NextResponse.json(
        { error: "Composio authentication failed" },
        { status }
      );
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
    // Try toolkit slug lookup as fallback
    const listed = await composioGet(
      `/auth_configs?toolkit_slugs=${encodeURIComponent(decodedId)}&limit=20`,
      key
    );
    if (listed.ok) {
      try {
        const body = await listed.json();
        const item = firstEnabledAuthConfig(body);
        const itemId = getNestedString(item, ["id"]) || getNestedString(item, ["auth_config", "id"]);
        if (itemId) {
          const fetched = await composioGet(`/auth_configs/${encodeURIComponent(itemId)}`, key);
          authConfig = fetched.ok ? await fetched.json() : item;
        } else {
          authConfig = item;
        }
      } catch {
        authConfig = undefined;
      }
    }
  }

  return NextResponse.json({
    id: getNestedString(authConfig, ["id"]) || getNestedString(authConfig, ["auth_config", "id"]) || decodedId,
    scopes: extractScopes(authConfig),
  });
}

/**
 * Fetch all auth config ids referenced by local connections.
 * An auth config id is valid if any composio_connection's auth_config_id matches it.
 * Also includes app name slugs since the route accepts toolkit slugs.
 * Returns null to fail open when the backend is unreachable.
 */
async function fetchLocalAuthConfigIds(): Promise<Set<string> | null> {
  if (!API_SECRET) return null; // dev mode: skip validation
  try {
    const res = await fetch(`${API_BASE}/connections`, {
      headers: { "x-floom-secret": API_SECRET, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const list = (await res.json()) as {
      composio_connection_id?: string;
      app_name?: string;
    }[];
    if (!Array.isArray(list)) return null;
    const ids = new Set<string>();
    for (const item of list) {
      // Accept by app_name slug (for toolkit slug lookup)
      if (typeof item.app_name === "string" && item.app_name) {
        ids.add(item.app_name.toLowerCase().trim());
      }
    }
    return ids;
  } catch {
    return null; // backend unreachable: fail open
  }
}

async function composioGet(path: string, apiKey: string) {
  return fetch(`${COMPOSIO_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    cache: "no-store",
  });
}

function firstEnabledAuthConfig(body: unknown) {
  const items = getNestedArray(body, ["items"]);
  return (
    items.find((item) => {
      const status = getNestedString(item, ["status"]);
      return !status || status.toUpperCase() === "ENABLED";
    }) ?? items[0]
  );
}

function extractScopes(body: unknown): string[] {
  const candidates = [
    body,
    getNestedObject(body, ["auth_config"]),
    getNestedObject(body, ["auth_config", "auth_scheme"]),
    getNestedObject(body, ["auth_scheme"]),
    getNestedObject(body, ["config"]),
    getNestedObject(body, ["oauth"]),
  ];

  for (const candidate of candidates) {
    const scopes = [
      getNestedArray(candidate, ["scopes"]),
      getNestedArray(candidate, ["oauth_scopes"]),
      getNestedArray(candidate, ["requested_scopes"]),
      getNestedArray(candidate, ["default_scopes"]),
    ].find((items) => items.length > 0);
    if (scopes && scopes.length > 0) {
      return scopes.filter((scope): scope is string => typeof scope === "string");
    }

    const scope = getNestedString(candidate, ["scope"]);
    if (scope) {
      return scope.split(/[,\s]+/).filter(Boolean);
    }
  }

  return [];
}

function getNestedObject(value: unknown, path: string[]): JsonObject | undefined {
  const current = path.reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || Array.isArray(acc)) return undefined;
    return (acc as JsonObject)[key];
  }, value);
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as JsonObject)
    : undefined;
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
