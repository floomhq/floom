import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const SESSION_COOKIE = "workeros_cloud_session";

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

export async function GET() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (!raw) {
    return NextResponse.json({ user: null }, { status: 200 });
  }
  let payload: { access_token?: string };
  try {
    payload = JSON.parse(decodeBase64Url(raw));
  } catch {
    return NextResponse.json({ user: null }, { status: 200 });
  }
  if (!payload.access_token) {
    return NextResponse.json({ user: null }, { status: 200 });
  }
  const jwt = parseJwt(payload.access_token);
  if (!jwt) {
    return NextResponse.json({ user: null }, { status: 200 });
  }
  const email = typeof jwt.email === "string" ? jwt.email : null;
  const userId = typeof jwt.sub === "string" ? jwt.sub : null;
  return NextResponse.json({ user: { id: userId, email } });
}
