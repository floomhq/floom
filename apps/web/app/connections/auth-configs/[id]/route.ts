import { NextResponse } from "next/server";

const COMPOSIO_BASE =
  process.env.COMPOSIO_API_BASE || "https://backend.composio.dev/api/v3";
const API_BASE = process.env.FLOOM_API_BASE || "https://workers-api.floom.dev";
const API_SECRET = process.env.FLOOM_API_SECRET || "";

type JsonObject = Record<string, unknown>;
type LocalAuthConfigValidation =
  | { ok: true; ids: Set<string> }
  | { ok: false; response: NextResponse };
type ConnectedAuthConfigLookup =
  | { ok: true; authConfigId?: string }
  | { ok: false };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const decodedId = decodeURIComponent(id);
  const key = process.env.COMPOSIO_API_KEY || "";

  // Verify the auth config id is referenced by at least one local connection
  const validAuthConfigIds = await fetchLocalAuthConfigIds(decodedId, key);
  if (!validAuthConfigIds.ok) return validAuthConfigIds.response;
  if (!validAuthConfigIds.ids.has(decodedId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!key) {
    return NextResponse.json(
      { error: "Connections backend not configured" },
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
        { error: "Connection authentication failed" },
        { status }
      );
    }
    if (status === 429) {
      return NextResponse.json(
        { error: "Connection rate limit exceeded" },
        { status: 429 }
      );
    }
    if (status >= 500) {
      return NextResponse.json(
        { error: "Connection service unavailable" },
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

async function fetchLocalAuthConfigIds(
  requestedId: string,
  composioApiKey: string
): Promise<LocalAuthConfigValidation> {
  if (!API_SECRET) return ownershipUnavailable();
  try {
    const res = await fetch(`${API_BASE}/connections`, {
      headers: { "x-floom-secret": API_SECRET, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return ownershipUnavailable();
    const list = (await res.json()) as {
      composio_connection_id?: string;
      app_name?: string;
    }[];
    if (!Array.isArray(list)) return ownershipUnavailable();
    const ids = new Set<string>();
    for (const item of list) {
      // Accept by app_name slug (for toolkit slug lookup)
      if (typeof item.app_name === "string" && item.app_name) {
        ids.add(item.app_name.toLowerCase().trim());
      }
    }

    if (requestedId.startsWith("ac_")) {
      if (!composioApiKey) return ownershipUnavailable();

      for (const connectionId of localConnectionIds(list)) {
        const result = await fetchConnectedAccountAuthConfigId(connectionId, composioApiKey);
        if (!result.ok) return ownershipUnavailable();
        if (result.authConfigId) ids.add(result.authConfigId);
      }
    }

    return { ok: true, ids };
  } catch {
    return ownershipUnavailable();
  }
}

function ownershipUnavailable(): LocalAuthConfigValidation {
  return {
    ok: false,
    response: NextResponse.json(
      { error: "Cannot verify ownership: backend unavailable" },
      { status: 503 }
    ),
  };
}

function localConnectionIds(list: { composio_connection_id?: string }[]) {
  return list
    .map((item) => item.composio_connection_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function fetchConnectedAccountAuthConfigId(
  connectionId: string,
  apiKey: string
): Promise<ConnectedAuthConfigLookup> {
  const response = await composioGet(
    `/connected_accounts/${encodeURIComponent(connectionId)}`,
    apiKey
  );
  if (response.status === 404) return { ok: true as const };
  if (!response.ok) return { ok: false as const };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false as const };
  }

  const account = getNestedObject(body, ["connected_account"]) ?? asObject(body);
  return {
    ok: true as const,
    authConfigId:
      getNestedString(account, ["auth_config", "id"]) ||
      getNestedString(account, ["authConfig", "id"]) ||
      getNestedString(account, ["auth_config_id"]),
  };
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

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
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
