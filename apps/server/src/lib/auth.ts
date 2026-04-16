// Auth middleware for Floom self-host.
//
// Two layers:
//   1. Global auth (FLOOM_AUTH_TOKEN env var) — if set, every /api/*, /mcp/*,
//      and /p/* call must present a matching Authorization: Bearer <token>
//      header (or ?access_token=... for GET endpoints). Health remains open.
//   2. Per-app auth (app.visibility === 'auth-required') — on top of any
//      global auth, the specific app can be gated even when global auth is
//      off. Uses the same FLOOM_AUTH_TOKEN bearer check.
//
// This is intentionally minimal. Better Auth / SSO / per-user tokens are
// roadmap items for v0.3+; for v0.2 a single shared token is sufficient to
// stop casual abuse when a self-hoster exposes port 3051 to the internet.
import type { Context, MiddlewareHandler } from 'hono';
import type { SessionContext } from '../types.js';
import { isCloudMode } from './better-auth.js';

function getExpectedToken(): string | null {
  const token = process.env.FLOOM_AUTH_TOKEN;
  if (!token || token.length === 0) return null;
  return token;
}

function presentedToken(c: Context): string | null {
  const header = c.req.header('authorization') || c.req.header('Authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (match) return match[1];
  }
  const q = c.req.query('access_token');
  if (q) return q;
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Global auth middleware. When FLOOM_AUTH_TOKEN is set, reject any request
 * whose bearer token doesn't match. Health and static files bypass this.
 *
 * When the env var is unset, the middleware is a no-op — Floom stays
 * publicly accessible, matching the current behavior.
 */
export const globalAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const expected = getExpectedToken();
  if (!expected) return next(); // no global auth configured

  // Always allow the health endpoint so Docker/k8s probes work.
  const path = new URL(c.req.url).pathname;
  if (path === '/api/health' || path === '/api/health/') return next();

  const got = presentedToken(c);
  if (!got || !constantTimeEqual(got, expected)) {
    return c.json({ error: 'Unauthorized: missing or invalid Floom token' }, 401);
  }
  return next();
};

/**
 * Per-app auth check. Call at the top of a route handler where `app` has
 * already been loaded. Returns null if authorized, or a Response if blocked.
 */
export function checkAppVisibility(
  c: Context,
  visibility: 'public' | 'auth-required',
): Response | null {
  if (visibility === 'public') return null;
  const expected = getExpectedToken();
  if (!expected) {
    // App is auth-required but no token env var is set. Deny by default —
    // better than silently allowing.
    return c.json(
      {
        error:
          'App requires authentication but FLOOM_AUTH_TOKEN is not set on the server. Set the env var and retry.',
      },
      401,
    );
  }
  const got = presentedToken(c);
  if (!got || !constantTimeEqual(got, expected)) {
    return c.json({ error: 'Unauthorized: app requires a bearer token' }, 401);
  }
  return null;
}

/**
 * Helper for use inside a Hono handler that needs to branch on auth.
 * Returns true if the caller is authenticated, false otherwise.
 */
export function isAuthenticated(c: Context): boolean {
  const expected = getExpectedToken();
  if (!expected) return true; // no auth configured = everyone is "authed"
  const got = presentedToken(c);
  return got !== null && constantTimeEqual(got, expected);
}

/**
 * Cloud-mode authentication gate for write routes.
 *
 * In OSS mode (FLOOM_CLOUD_MODE unset/false) every request is synthesized
 * as the local user and this is a no-op. In Cloud mode this rejects any
 * request whose SessionContext is not backed by a real Better Auth session,
 * so anonymous callers cannot create/update/delete resources owned by the
 * synthetic local user.
 *
 * Usage:
 *   const ctx = await resolveUserContext(c);
 *   const gate = requireAuthenticatedInCloud(c, ctx);
 *   if (gate) return gate;
 */
export function requireAuthenticatedInCloud(
  c: Context,
  ctx: SessionContext,
): Response | null {
  if (!isCloudMode()) return null;
  if (ctx.is_authenticated) return null;
  return c.json(
    {
      error: 'Authentication required. Sign in and retry.',
      code: 'auth_required',
    },
    401,
  );
}
