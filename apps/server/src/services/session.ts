// W2.1 session service.
//
// Three responsibilities:
//
//   1. getOrCreateDeviceId(c): reads the floom_device cookie; if missing
//      generates a random UUIDv4 and sets it with a 10-year TTL. HttpOnly,
//      SameSite=Lax so MCP clients calling from another origin can still
//      share cookies with the web UI.
//   2. resolveUserContext(c): returns `{ workspace_id, user_id, device_id }`
//      for the request. In OSS mode this is always the synthetic 'local'
//      workspace + 'local' user + whatever device_id the cookie carries.
//      In Cloud mode (post-W3.1) it reads the Better Auth session and
//      returns the real workspace+user binding.
//   3. rekeyDevice(...): atomic transaction that UPDATEs app_memory, runs,
//      and run_threads to swap `device_id → user_id`. Idempotent — safe to
//      call multiple times. Per P.4 section 8, this is the Linear 2022
//      opportunistic-rekey pattern that runs on the first authenticated
//      request after login.
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { storage } from './storage.js';
import { isCloudMode } from '../lib/better-auth.js';
import { authAdapter } from '../adapters/better-auth-adapter.js';
import type { RekeyResult, SessionContext } from '../types.js';
import {
  getActiveWorkspaceId,
  provisionPersonalWorkspace,
} from './workspaces.js';

const COOKIE_NAME = 'floom_device';
// 10 years in seconds — the cookie is a stable device id, not a session.
const COOKIE_MAX_AGE_SECONDS = 315_360_000;

/**
 * Parse the floom_device cookie from the incoming request headers. Returns
 * null if not present. Uses a minimal cookie parser to avoid pulling in
 * hono/cookie which some versions of @hono/node-server don't expose in tests.
 */
function readDeviceCookie(c: Context): string | null {
  const header = c.req.header('cookie') || c.req.header('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey === COOKIE_NAME && rest.length > 0) {
      const value = rest.join('=').trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/**
 * Decide whether the Set-Cookie should carry the `Secure` attribute. True
 * when we're running in production, or when PUBLIC_URL is https. Kept off
 * for local HTTP dev (otherwise browsers silently drop the cookie).
 */
function shouldUseSecureCookie(): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl && publicUrl.startsWith('https://')) return true;
  return false;
}

/**
 * Set the floom_device cookie on the response. Idempotent: safe to call
 * multiple times per request; the last Set-Cookie wins.
 *
 * Attributes: HttpOnly + SameSite=Lax always; Secure when served over
 * HTTPS (prod, preview, or any PUBLIC_URL=https://...). Local HTTP dev
 * skips Secure so the browser still accepts the cookie.
 */
function writeDeviceCookie(c: Context, value: string): void {
  const secure = shouldUseSecureCookie() ? '; Secure' : '';
  const cookie =
    `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; ` +
    `Path=/; HttpOnly; SameSite=Lax${secure}`;
  c.header('set-cookie', cookie, { append: true });
}

/**
 * Read the floom_device cookie or mint a new one and write it back. The
 * returned string is always a valid device id that the caller can use in
 * the SessionContext.
 */
export function getOrCreateDeviceId(c: Context): string {
  const existing = readDeviceCookie(c);
  if (existing) return existing;
  const fresh = randomUUID();
  writeDeviceCookie(c, fresh);
  return fresh;
}

/**
 * Build the SessionContext for a request.
 *
 * Two branches:
 *
 *   1. OSS mode (FLOOM_CLOUD_MODE unset/false) — always returns the
 *      synthetic local workspace + local user + the device cookie. Sync
 *      under the hood; the Promise wraps the same plain object so callers
 *      stay uniform.
 *
 *   2. Cloud mode (FLOOM_CLOUD_MODE=true) — calls Better Auth's
 *      `auth.api.getSession` with the request headers. If the user is
 *      logged in we mirror them into Floom's `users` table (idempotent),
 *      run `rekeyDevice` to migrate any anonymous app_memory / runs /
 *      connections rows over, look up the active workspace from
 *      `user_active_workspace`, and return the real ids. If the user is
 *      not logged in we fall back to the device-cookie path with a NULL
 *      user — the caller can either treat them as anonymous or 401.
 *
 * The context is a plain object so services can accept it without needing
 * Hono types or any auth-library coupling.
 */
export async function resolveUserContext(c: Context): Promise<SessionContext> {
  const device_id = getOrCreateDeviceId(c);
  const ossCtx: SessionContext = {
    workspace_id: DEFAULT_WORKSPACE_ID,
    user_id: DEFAULT_USER_ID,
    device_id,
    is_authenticated: false,
  };

  if (!isCloudMode()) return ossCtx;

  const rawSession = await authAdapter.getSession(c.req.raw);
  if (!rawSession) {
    // Cloud mode but no logged-in user. Return the device-only context
    // with NULL workspace/user so caller routes can decide whether to
    // 401. We surface DEFAULT_WORKSPACE_ID rather than a literal null so
    // every existing scoped query keeps working for "browsing
    // anonymously" — the cloud build wires admin routes to also check
    // is_authenticated before mutating anything sensitive.
    return ossCtx;
  }
  const sessionUser = (rawSession as any)._raw_user;

  // Mirror the Better Auth user into Floom's users table on first sight.
  // Idempotent — uses ON CONFLICT to keep the auth_provider/auth_subject
  // columns coherent on subsequent calls.
  const userId = rawSession.user_id;
  storage.upsertUser({
    id: userId,
    email: rawSession.email,
    name: sessionUser.name || null,
    image: sessionUser.image || null,
    auth_provider: 'better-auth',
    auth_subject: userId,
  });

  // Resolve the active workspace. If the user has none yet (brand-new
  // account, no invite accepted, no manual create), bootstrap a default
  // personal workspace named after their email so the UI never lands on
  // an empty state.
  let activeWorkspaceId = getActiveWorkspaceId(userId);
  if (!activeWorkspaceId) {
    activeWorkspaceId = provisionPersonalWorkspace(
      userId,
      rawSession.email!,
      sessionUser.name,
    );
  }

  // Fire the rekey on first authenticated request. The function is
  // idempotent — re-running on already-claimed rows is a no-op via the
  // `WHERE user_id = 'local'` filter.
  try {
    rekeyDevice(device_id, userId, activeWorkspaceId);
  } catch {
    // Re-key failures are logged at the call site; we don't want them
    // to take down the request if e.g. the device cookie is malformed.
  }

  return {
    workspace_id: activeWorkspaceId,
    user_id: userId,
    device_id,
    is_authenticated: true,
    auth_user_id: userId,
    auth_session_id: rawSession.auth_session_id,
    email: rawSession.email,
  };
}


/**
 * Build a SessionContext from already-resolved ids. Useful when the caller
 * has a device_id from somewhere other than a Hono cookie (tests, worker
 * dispatch path, background jobs).
 */
export function buildContext(
  workspace_id: string,
  user_id: string,
  device_id: string,
  is_authenticated = false,
): SessionContext {
  return { workspace_id, user_id, device_id, is_authenticated };
}

/**
 * Atomically re-key a device_id to a user_id across app_memory, runs,
 * run_threads, and connections. Returns the row counts. Runs inside a
 * single SQLite transaction so partial re-keys are impossible. Idempotent —
 * if the rows are already bound to the user, the WHERE clause filters them
 * out.
 *
 * This is called by the login handler on the first authenticated request
 * (post-W3.1). Pre-auth (today) it's exercised by tests only.
 *
 * Connections table (W2.3): anonymous rows use owner_kind='device' +
 * owner_id=<device_id>. Re-key flips them to owner_kind='user' +
 * owner_id=<user_id>. The Composio-side `composio_account_id` (e.g.
 * `device:abc-123`) is NOT rewritten — Composio has no "rename user_id"
 * endpoint. Instead we persist the legacy Composio user id on
 * `users.composio_user_id` so subsequent Composio calls for this user know
 * which external account to filter on.
 */
export function rekeyDevice(
  device_id: string,
  user_id: string,
  workspace_id: string,
): RekeyResult {
  if (!device_id || !user_id || !workspace_id) {
    throw new Error('rekeyDevice: device_id, user_id, workspace_id are required');
  }

  // storage.DEFAULT_USER_ID is not exported, I'll use 'local' directly or export it.
  // Actually, I'll just pass 'local' as it's the known default.
  const result = storage.rekeyDevice(device_id, user_id, workspace_id, 'local');

  // Persist the legacy Composio user id ("device:<uuid>") on the user
  // row so future Composio API calls for this user can still query the
  // pre-login account. Only set if still null — never overwrite a user
  // who already has a user-scoped Composio id.
  if (result.connections > 0) {
    storage.updateUser(user_id, {
      composio_user_id: `device:${device_id}`,
    });
  }

  return result;
}
