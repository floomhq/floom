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

  const response = await fetch(
    `${COMPOSIO_BASE}/connected_accounts/${encodeURIComponent(decodeURIComponent(id))}`,
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      cache: "no-store",
    }
  );

  if (!response.ok) {
    return NextResponse.json({ id, scopes: [] }, { status: 200 });
  }

  const body = await response.json();
  const account = getNestedObject(body, ["connected_account"]) ?? asObject(body);
  return NextResponse.json({
    id: getNestedString(account, ["id"]) || id,
    auth_config_id:
      getNestedString(account, ["auth_config", "id"]) ||
      getNestedString(account, ["authConfig", "id"]) ||
      getNestedString(account, ["auth_config_id"]),
    email: extractEmail(account),
    scopes: extractStringArray(account, ["scopes"]),
    user_id: getNestedString(account, ["user_id"]) || getNestedString(account, ["userId"]),
  });
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
