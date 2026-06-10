import type { CurrentUser } from "../../lib/types";

export const SESSION_COOKIE = "workeros_cloud_session";

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

function parseJwt(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const candidate = readString(value);
    if (candidate) return candidate;
  }
  return null;
}

export function parseCurrentUser(rawCookieValue: string | undefined | null): CurrentUser | null {
  if (!rawCookieValue) return null;

  let payload: { access_token?: string };
  try {
    payload = JSON.parse(decodeBase64Url(rawCookieValue));
  } catch {
    return null;
  }
  if (!payload.access_token) return null;

  const jwt = parseJwt(payload.access_token);
  if (!jwt) return null;

  const userMetadata = readRecord(jwt.user_metadata);
  const email = readString(jwt.email);
  const userId = readString(jwt.sub);
  if (!userId) return null;

  const displayName = firstString(
    userMetadata.full_name,
    userMetadata.name,
    userMetadata.display_name,
    userMetadata.preferred_name,
    jwt.name,
    jwt.full_name,
  ) ?? email;
  const picture = firstString(
    userMetadata.picture,
    userMetadata.avatar_url,
    userMetadata.avatarUrl,
    jwt.picture,
    jwt.avatar_url,
  );

  return {
    user_id: userId,
    email,
    display_name: displayName,
    picture,
  };
}
