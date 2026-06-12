// #935 — the middleware/proxy/me routes trusted the workeros_cloud_session
// cookie after a base64 decode, without verifying the Supabase JWT signature.
// A forged cookie with a future expires_at bypassed the frontend auth
// boundary and could present a fake user in the UI.
//
// This verifies the access token against the Supabase project's JWKS
// (auth/v1/.well-known/jwks.json), mirroring the backend's
// apps/api/auth/supabase_provider.py (ES256, audience "authenticated").
// jose's createRemoteJWKSet caches keys and re-fetches on unknown kid, so
// verification is offline after the first request per isolate.
//
// Fail-open ONLY when no Supabase URL is configured at all (local dev /
// engine-only deployments without cloud auth): there the structural check is
// all that ever existed, and failing closed would lock out deployments that
// do not even use this cookie. When a Supabase URL IS configured, every
// verification error fails closed.

import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

export type SessionPayload = {
  access_token: string;
  expires_at: number;
  user_id: string;
};

function normalizeCookieValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function decodeBase64Url(value: string): string | null {
  try {
    value = normalizeCookieValue(value);
    const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
    const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
    return atob(normalized);
  } catch {
    return null;
  }
}

/** Structure + expiry check (the pre-#935 behavior). No signature proof. */
export function parseSessionPayload(raw: string | undefined): SessionPayload | null {
  if (!raw) return null;
  const decoded = decodeBase64Url(raw);
  if (!decoded) return null;
  try {
    const payload = JSON.parse(decoded) as Partial<SessionPayload>;
    if (typeof payload.access_token !== "string" || !payload.access_token) return null;
    if (typeof payload.user_id !== "string" || !payload.user_id) return null;
    const expiresAt = Number(payload.expires_at);
    if (!Number.isFinite(expiresAt)) return null;
    if (expiresAt <= Math.floor(Date.now() / 1000) + 30) return null;
    return {
      access_token: payload.access_token,
      expires_at: expiresAt,
      user_id: payload.user_id,
    };
  } catch {
    return null;
  }
}

export function getSupabaseUrl(): string | null {
  const url = (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.WORKEROS_CLOUD_SUPABASE_URL ||
    ""
  ).trim();
  return url || null;
}

// One JWKS per isolate; recreated only if the configured URL changes (tests).
let jwksCache: { url: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

function getJwks(supabaseUrl: string) {
  if (!jwksCache || jwksCache.url !== supabaseUrl) {
    const jwksUrl = new URL("auth/v1/.well-known/jwks.json", supabaseUrl.replace(/\/?$/, "/"));
    jwksCache = { url: supabaseUrl, jwks: createRemoteJWKSet(jwksUrl) };
  }
  return jwksCache.jwks;
}

/** Test seam: drop the per-isolate JWKS cache. */
export function resetJwksCacheForTests(): void {
  jwksCache = null;
}

/**
 * Full session verification: structure + expiry + JWT signature (when a
 * Supabase URL is configured). Returns the payload only when the session is
 * trustworthy, with `verified` saying whether a signature was proven.
 */
export async function verifySession(
  raw: string | undefined,
): Promise<{ payload: SessionPayload; verified: boolean } | null> {
  const payload = parseSessionPayload(raw);
  if (!payload) return null;

  const supabaseUrl = getSupabaseUrl();
  if (!supabaseUrl) {
    // No cloud auth configured — nothing to verify against. Keep the
    // structural check (pre-existing behavior) rather than locking out
    // non-Supabase deployments.
    return { payload, verified: false };
  }

  try {
    const { payload: claims } = await jwtVerify(payload.access_token, getJwks(supabaseUrl), {
      audience: "authenticated",
    });
    if (!claims.sub || claims.sub !== payload.user_id) return null;
    return { payload, verified: true };
  } catch {
    return null; // configured => fail closed on any verification error
  }
}

/** Claims of a verified token (display fields for /api/me). */
export function unsafeDecodeClaims(token: string): Record<string, unknown> | null {
  try {
    return decodeJwt(token);
  } catch {
    return null;
  }
}
