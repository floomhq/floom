// Pentest P0 hardening for Better Auth responses (2026-04-22).
//
// Wraps the Better Auth fetch handler so we can scrub the JSON body on
// the two password endpoints flagged by the pentest:
//
//   #375  Strip `token` from /auth/sign-in/email and /auth/sign-up/email
//         response bodies. The HttpOnly+Secure session cookie is already
//         set via Set-Cookie by Better Auth, so echoing the token in the
//         body only ever helps an attacker (XSS, third-party scripts,
//         devtools-leaky logs, accidental fetch `.json()` spills into
//         analytics). The cookie is the single source of truth.
//
//   #376  Pad /auth/sign-up/email response timing to a constant floor.
//         Better Auth's `requireEmailVerification: true` already makes
//         the duplicate-email response byte-identical to a fresh sign-up
//         (see better-auth/dist/api/routes/sign-up.mjs lines 160-204 —
//         `shouldReturnGenericDuplicateResponse` returns a synthetic
//         user with a hashed password so the work done matches). The
//         only residual enumeration signal is wall-clock delta between
//         the duplicate branch (DB lookup + hash) and the fresh branch
//         (DB insert + hash + session create). Padding to a fixed floor
//         flattens that delta. Sign-in gets the same treatment because
//         Better Auth's bcrypt cost is constant but I/O around it
//         isn't — a user-exists+wrong-password vs user-doesn't-exist
//         attacker could still measure timing at bulk.
//
// Keep this module free of server/index.ts imports so it stays easy to
// unit-test with a fake handler.

/** Public routes whose JSON body must be scrubbed of `token` before send. */
const SCRUB_PATHS = new Set<string>([
  '/auth/sign-in/email',
  '/auth/sign-up/email',
]);

/** Routes whose timing must be padded to a fixed floor. */
const TIMING_PAD_PATHS = new Set<string>([
  '/auth/sign-in/email',
  '/auth/sign-up/email',
]);

/**
 * Timing floor for password-bearing auth endpoints. Chosen to comfortably
 * exceed the natural worst case Better Auth produces (duplicate-email
 * branch hashes a password ≈ 80-120ms on prod hardware) plus a safety
 * margin for GC pauses + SQLite contention. Short enough that users
 * don't perceive it as slow.
 */
export const AUTH_TIMING_FLOOR_MS = 600;

export function shouldScrubAuthBody(pathname: string): boolean {
  return SCRUB_PATHS.has(pathname);
}

export function shouldPadAuthTiming(pathname: string): boolean {
  return TIMING_PAD_PATHS.has(pathname);
}

/**
 * Return a copy of `res` with `token` removed from the parsed JSON body,
 * preserving every other field (user, redirect flag, etc.) and every
 * response header (especially Set-Cookie). Non-JSON, non-2xx, and
 * unparseable bodies are returned untouched — there's no session token
 * in those cases anyway.
 */
export async function scrubAuthResponseBody(res: Response): Promise<Response> {
  if (res.status < 200 || res.status >= 300) return res;
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) return res;

  // Clone before parsing so Better Auth's stream stays usable for
  // anything that may branch on it downstream. We return a fresh
  // Response, so the clone is belt-and-suspenders.
  const parsed = (await res
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return res;

  // Only `token` is the pentest target — `redirect` and `url` are
  // navigation hints for Better Auth's browser SDK, harmless on their
  // own. Leave them in to avoid surprising downstream callers.
  if (!('token' in parsed)) return res;
  delete parsed.token;

  // Copy headers so Set-Cookie (and any pentest-batch CSP overrides)
  // survive. Recompute content-length because some proxies truncate on
  // a stale value; the undici client Node ships has done so before.
  const headers = new Headers(res.headers);
  const body = JSON.stringify(parsed);
  headers.set('content-length', String(Buffer.byteLength(body, 'utf8')));
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Resolve after `ms` milliseconds. Exported so tests can swap it out
 * (node:test has no built-in fake-timers, so we let callers inject).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pad an already-computed elapsed duration up to `AUTH_TIMING_FLOOR_MS`.
 * No-op when we're already past the floor.
 */
export async function padToFloor(startedAtMs: number): Promise<void> {
  const elapsed = Date.now() - startedAtMs;
  const remaining = AUTH_TIMING_FLOOR_MS - elapsed;
  if (remaining <= 0) return;
  await sleep(remaining);
}
