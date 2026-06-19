// Single-tenant web access gate.
//
// The public frontend (localhost:3000) proxies every request to
// localhost:8000 with a server-injected `x-floom-secret`. Without a
// client-auth gate, ANY anonymous visitor could read/write the owner's data
// through /api/proxy/*. This module is the minimal session primitive that
// closes that hole.
//
// Model: single owner who knows the deploy secret (FLOOM_API_SECRET). Logging
// in == proving you know the secret. We never store the raw secret in the
// cookie — the cookie carries an HMAC-SHA256 token derived from the secret, so
// a leaked cookie cannot be turned back into the API secret, and the server can
// verify it statelessly.
//
// Edge-compatible: uses Web Crypto (globalThis.crypto.subtle), so the same
// helpers run in `middleware.ts` (Edge runtime) and in route handlers.

export const SESSION_COOKIE = "workeros_session";

// Versioned, fixed message that we HMAC with the secret to derive the cookie
// token. Bumping the version invalidates all existing sessions.
const SESSION_MESSAGE = "workeros-web-session-v1";

function getSecret(): string {
  return process.env.FLOOM_API_SECRET || "";
}

// A memorable login password, DECOUPLED from the master API secret. Logging in
// with this mints the same HMAC session cookie (still derived from
// FLOOM_API_SECRET), but the password itself never touches the API, the
// signing keys, or the Cloudflare edge gate — those stay on the strong master
// secret. Brute-force is bounded by a Cloudflare rate-limit rule on
// /api/auth/login. Empty/unset -> only the master secret is accepted.
function getLoginPassword(): string {
  return process.env.WORKEROS_LOGIN_PASSWORD || "";
}

/** Constant-time match of `candidate` against a configured credential. */
function matchesCredential(candidate: string, configured: string): boolean {
  if (!configured) return false;
  if (candidate.length !== configured.length) return false;
  return timingSafeEqual(candidate, configured);
}

function bytesToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToHex(sig);
}

/** Constant-time string comparison (both inputs are hex of fixed length). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Derive the session-cookie token from the configured secret. This is the
 * value we set in the cookie on successful login and re-derive to verify.
 */
export async function deriveSessionToken(): Promise<string> {
  const secret = getSecret();
  // No secret configured -> no derivable token. Return empty (Web Crypto
  // rejects a zero-length HMAC key); callers fail closed on an empty token.
  if (!secret) return "";
  return hmacHex(secret, SESSION_MESSAGE);
}

/**
 * True if the supplied value is an accepted login credential: EITHER the master
 * FLOOM_API_SECRET (used by agents / non-interactive auth and the proxy) OR the
 * memorable WORKEROS_LOGIN_PASSWORD (the human owner login). Both mint the same
 * session cookie. Evaluates both branches (no early short-circuit) so a wrong
 * value's timing doesn't reveal which credential it was closest to.
 */
export function isCorrectSecret(candidate: string): boolean {
  const secret = getSecret();
  const password = getLoginPassword();
  // Fail closed: never accept login when no credential is configured at all.
  if (!secret && !password) return false;
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const matchSecret = matchesCredential(candidate, secret);
  const matchPassword = matchesCredential(candidate, password);
  return matchSecret || matchPassword;
}

/** Verify a cookie token against the configured secret. */
export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  const secret = getSecret();
  if (!secret) return false;
  if (typeof token !== "string" || token.length === 0) return false;
  const expected = await deriveSessionToken();
  return timingSafeEqual(token, expected);
}
