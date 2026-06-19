import { cookies } from "next/headers";

const SESSION_COOKIE_NAME = "workeros_cloud_session";

const API_BASE =
  process.env.WORKEROS_API_BASE ||
  process.env.NEXT_PUBLIC_WORKEROS_API_BASE ||
  "https://workeros-api.floom.dev";

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

  // The session cookie is "v2." + Fernet ciphertext (minted by the backend
  // apps/api/routes/auth.py). It cannot be decoded here without the Fernet
  // secret, so we ask the backend's GET /auth/session-token to validate it and
  // return a fresh Supabase access token. 401 ⇒ no usable session.
  let accessToken: string | null = null;
  try {
    const upstream = await fetch(`${API_BASE}/auth/session-token`, {
      method: "GET",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${raw}` },
      cache: "no-store",
    });
    if (!upstream.ok) return null;
    const payload = (await upstream.json().catch(() => null)) as
      | { access_token?: unknown }
      | null;
    const token = payload?.access_token;
    accessToken = typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }

  if (!accessToken) return null;

  // The access token is a standard Supabase JWT; its payload (email, sub) is
  // base64url-encoded and needs no secret to read for display.
  const jwt = parseJwt(accessToken);
  const email = jwt && typeof jwt.email === "string" ? jwt.email : null;
  const userId = jwt && typeof jwt.sub === "string" ? jwt.sub : null;

  return { email, userId, accessToken };
}
