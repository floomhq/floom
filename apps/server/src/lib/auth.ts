// Auth middleware for Floom self-host.
//
// Two layers:
//   1. Global auth (FLOOM_AUTH_TOKEN env var) — if set, every /api/*, /mcp/*,
//      and /p/* call must present a matching Authorization: Bearer <token>
//      header (or ?access_token=... for GET endpoints). Health remains open.
//   2. Per-app auth (app.visibility === 'auth-required') — on top of any
//      global auth, the specific app can be gated even when global auth is
//      off. Uses the same FLOOM_AUTH_TOKEN bearer check.
//   3. Per-app privacy (app.visibility === 'private') — only the app's
//      author (user_id) can run/list/view it. Used for user-owned apps
//      like ig-nano-scout that should never appear in the public directory.
//
// This is intentionally minimal. Better Auth / SSO / per-user tokens are
// roadmap items for v0.3+; for v0.2 a single shared token is sufficient to
// stop casual abuse when a self-hoster exposes port 3051 to the internet.
import type { Context, MiddlewareHandler } from 'hono';
import type { SessionContext } from '../types.js';
import { getPresentedAgentToken } from './agent-tokens.js';
import { isCloudMode } from './better-auth.js';

// Actionable hints embedded in every 401/403 auth response. Single source
// of truth so the ax-eval baseline fix (#536) can't drift across routes.
// Keep strings generic — no stack traces, no internal identifiers, no
// environment-specific tokens. Callers (CLI, agents, humans) should be
// able to act on the hint without knowing anything about the server.
export const AUTH_DOCS_URL = 'https://floom.dev/docs/auth';
export const AUTH_HINT_CLOUD =
  'Run `floom auth --device` or set FLOOM_API_KEY, then retry.';
export const AUTH_HINT_SELFHOST =
  'Set FLOOM_AUTH_TOKEN on the server and present it via Authorization: Bearer <token>.';
export const AUTH_HINT_SIGNATURE =
  'Compute the HMAC signature of the raw body with the shared secret and send it in the X-Floom-Signature header.';
export const AUTH_HINT_NOT_OWNER =
  'Sign in as the account that originally published this app.';

/**
 * Canonical `not_owner` 403 response. Used across hub and trigger routes so
 * the actionable hint stays consistent after the #536 audit.
 */
export function notOwnerResponse(c: Context): Response {
  return c.json(
    {
      error: 'Not the owner of this app',
      code: 'not_owner',
      hint: AUTH_HINT_NOT_OWNER,
      docs_url: AUTH_DOCS_URL,
    },
    403,
  );
}

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
  // Metrics is also exempt: it owns its own METRICS_TOKEN bearer auth so
  // an external Prometheus scraper can hit it without presenting the Floom
  // global token.
  const path = new URL(c.req.url).pathname;
  if (path === '/api/health' || path === '/api/health/') return next();
  if (path === '/api/metrics' || path === '/api/metrics/') return next();
  // Public read-only badge endpoint — used by the marketing TopBar for a
  // floomhq/floom star count. No credentials, no side effects; a self-
  // hosted instance with FLOOM_AUTH_TOKEN set still lets unauthenticated
  // visitors see the number on their own landing page.
  if (path === '/api/gh-stars' || path === '/api/gh-stars/') return next();

  const got = presentedToken(c);
  if (got && getPresentedAgentToken(c)) return next();
  if (!got || !constantTimeEqual(got, expected)) {
    return c.json(
      {
        error: 'Unauthorized: missing or invalid Floom token',
        code: 'auth_required',
        hint: AUTH_HINT_SELFHOST,
        docs_url: AUTH_DOCS_URL,
      },
      401,
    );
  }
  return next();
};

export type AppVisibility = 'public' | 'auth-required' | 'private';

/**
 * Per-app auth check. Call at the top of a route handler where `app` has
 * already been loaded. Returns null if authorized, or a Response if blocked.
 *
 * For 'private' visibility, pass `owner` (the app's `author` column) and
 * `ctx` (the resolved user context). Only the owner can pass the gate;
 * everyone else gets a 404 so the app's existence isn't leaked.
 */
export function checkAppVisibility(
  c: Context,
  visibility: AppVisibility | string | null | undefined,
  owner?: { author?: string | null; ctx?: SessionContext | null },
): Response | null {
  const v = (visibility || 'public') as AppVisibility;
  if (v === 'public') return null;

  if (v === 'private') {
    const author = owner?.author ?? null;
    const ctx = owner?.ctx ?? null;
    // No author on a private app is a data bug — deny safely rather than leak.
    if (!author) {
      return c.json({ error: 'App not found', code: 'not_found' }, 404);
    }
    // OSS mode: ctx.user_id is DEFAULT_USER_ID ('local') and author is 'local'
    // for locally-seeded apps, so this naturally passes. Cloud mode requires
    // an authenticated session whose user_id matches the app's author.
    if (!ctx || ctx.user_id !== author) {
      return c.json({ error: 'App not found', code: 'not_found' }, 404);
    }
    return null;
  }

  // 'auth-required' — falls back to the shared FLOOM_AUTH_TOKEN bearer check.
  const expected = getExpectedToken();
  if (!expected) {
    return c.json(
      {
        error:
          'App requires authentication but FLOOM_AUTH_TOKEN is not set on the server. Set the env var and retry.',
        code: 'auth_required',
        hint: AUTH_HINT_SELFHOST,
        docs_url: AUTH_DOCS_URL,
      },
      401,
    );
  }
  const got = presentedToken(c);
  if (!got || !constantTimeEqual(got, expected)) {
    return c.json(
      {
        error: 'Unauthorized: app requires a bearer token',
        code: 'auth_required',
        hint: AUTH_HINT_SELFHOST,
        docs_url: AUTH_DOCS_URL,
      },
      401,
    );
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
 * Server-admin bearer check. Returns true ONLY when FLOOM_AUTH_TOKEN is
 * configured AND the caller presented a matching bearer. Used by the
 * run-auth lockdown (P0 2026-04-20) to let the self-host operator fetch
 * any run by id with the shared admin token, without also opening the
 * floodgates when no token is configured at all.
 *
 * Distinct from `isAuthenticated` which returns true when no token is
 * configured ("public mode = everyone passes"). Here we explicitly want
 * a FALSE for that branch so the ownership gate keeps protecting runs in
 * OSS mode.
 */
export function hasValidAdminBearer(c: Context): boolean {
  const expected = getExpectedToken();
  if (!expected) return false;
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
      hint: AUTH_HINT_CLOUD,
      docs_url: AUTH_DOCS_URL,
    },
    401,
  );
}
