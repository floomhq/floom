import { NextResponse } from "next/server";

const COMPOSIO_BASE =
  process.env.COMPOSIO_API_BASE || "https://backend.composio.dev/api/v3";

type JsonObject = Record<string, unknown>;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const key = process.env.COMPOSIO_API_KEY || "";
  if (!key) {
    return NextResponse.json({ id, scopes: [] });
  }

  const decodedId = decodeURIComponent(id);
  const direct = await composioGet(`/auth_configs/${encodeURIComponent(decodedId)}`, key);
  let authConfig = direct.ok ? await direct.json() : undefined;

  if (!direct.ok) {
    const listed = await composioGet(
      `/auth_configs?toolkit_slugs=${encodeURIComponent(decodedId)}&limit=20`,
      key
    );
    if (listed.ok) {
      const body = await listed.json();
      const item = firstEnabledAuthConfig(body);
      const itemId = getNestedString(item, ["id"]) || getNestedString(item, ["auth_config", "id"]);
      if (itemId) {
        const fetched = await composioGet(`/auth_configs/${encodeURIComponent(itemId)}`, key);
        authConfig = fetched.ok ? await fetched.json() : item;
      } else {
        authConfig = item;
      }
    }
  }

  return NextResponse.json({
    id: getNestedString(authConfig, ["id"]) || getNestedString(authConfig, ["auth_config", "id"]) || decodedId,
    scopes: extractScopes(authConfig),
  });
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
