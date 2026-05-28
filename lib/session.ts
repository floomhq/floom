import { cookies } from "next/headers";

const SESSION_COOKIE_NAME = "workeros_cloud_session";

type SessionPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
};

function decodeBase64Url(value: string): string {
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

export async function readSession(): Promise<{
  email: string | null;
  userId: string | null;
  accessToken: string | null;
} | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(decodeBase64Url(raw));
  } catch {
    return null;
  }

  const accessToken = payload.access_token ?? null;
  if (!accessToken) return null;

  const jwt = parseJwt(accessToken);
  if (!jwt) return null;

  const email = typeof jwt.email === "string" ? jwt.email : null;
  const userId = typeof jwt.sub === "string" ? jwt.sub : null;

  return { email, userId, accessToken };
}
