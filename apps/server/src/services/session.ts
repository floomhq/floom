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
//      In Cloud mode (post-W3.1) it delegates auth and workspace resolution
//      to the configured AuthAdapter.
//   3. rekeyDevice(...): atomic transaction that UPDATEs app_memory, runs,
//      and run_threads to swap `device_id → user_id`. Idempotent — safe to
//      call multiple times. Per P.4 section 8, this is the Linear 2022
//      opportunistic-rekey pattern that runs on the first authenticated
//      request after login.
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import {
  DEFAULT_USER_ID,
  DEFAULT_WORKSPACE_ID,
} from '../db.js';
import { adapters } from '../adapters/index.js';
import type { SessionContext } from '../types.js';
export { rekeyDevice } from './device-rekey.js';

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

function requestWithDeviceCookie(c: Context, device_id: string): Request {
  const raw = c.req.raw as Request;
  const headers = new Headers(raw.headers);
  const existing = headers.get('cookie') || headers.get('Cookie');
  const deviceCookie = `${COOKIE_NAME}=${encodeURIComponent(device_id)}`;
  if (!existing) {
    headers.set('cookie', deviceCookie);
  } else if (!/(^|;\s*)floom_device=/.test(existing)) {
    headers.set('cookie', `${existing}; ${deviceCookie}`);
  }
  const url =
    typeof raw.url === 'string' && raw.url.length > 0
      ? raw.url
      : 'http://localhost/';
  const method =
    typeof raw.method === 'string' && raw.method.length > 0
      ? raw.method
      : 'GET';
  return new Request(url, { method, headers });
}

/**
 * Build the SessionContext for a request.
 *
 * Auth resolution is delegated to the configured AuthAdapter. This wrapper
 * keeps the Hono-specific device-cookie write behavior and preserves the
 * historical anonymous fallback for routes that allow browsing before login.
 */
export async function resolveUserContext(c: Context): Promise<SessionContext> {
  const device_id = getOrCreateDeviceId(c);
  const fallbackCtx: SessionContext = {
    workspace_id: DEFAULT_WORKSPACE_ID,
    user_id: DEFAULT_USER_ID,
    device_id,
    is_authenticated: false,
  };
  const session = await adapters.auth.getSession(
    requestWithDeviceCookie(c, device_id),
  );
  return session ? { ...session, device_id } : fallbackCtx;
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
