// Progressive server-side delay after repeated failed email+password sign-ins (#388).
// In-memory per (email, IP); no extra response fields — same 401/400 shape as
// before so we do not signal throttling to clients.

import type { Context } from 'hono';
import { sleep } from './auth-response-guard.js';
import { extractIp } from './client-ip.js';

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function presentedAdminToken(c: Context): string | null {
  const header = c.req.header('authorization') || c.req.header('Authorization');
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m) return m[1].trim();
  }
  const q = c.req.query('access_token');
  return q || null;
}

/** Same behaviour as `hasValidAdminBearer` in auth.ts — duplicated to avoid loading Better Auth / db. */
function hasValidAdminBearer(c: Context): boolean {
  const expected = process.env.FLOOM_AUTH_TOKEN;
  if (!expected || expected.length === 0) return false;
  const got = presentedAdminToken(c);
  if (!got) return false;
  return constantTimeEqual(got, expected);
}

interface Entry {
  consecutiveFailures: number;
  lastActivityAt: number;
}

const store = new Map<string, Entry>();
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_ENTRY_MS = 60 * 60 * 1000; // 1h inactivity: treat as fresh tuple

function envBoolean(name: string, defaultOn: boolean): boolean {
  const raw = (process.env[name] || '').toLowerCase().trim();
  if (!raw) return defaultOn;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  return defaultOn;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** When unset or truthy, progressive delay is enabled. Set to `false` to disable. */
export function isProgressiveSigninDelayEnabled(): boolean {
  return envBoolean('FLOOM_SIGNIN_PROGRESSIVE_DELAY', true);
}

export function defaultProgressiveDelayThreshold(): number {
  return Math.max(1, Math.floor(envNumber('FLOOM_SIGNIN_PROGRESSIVE_DELAY_THRESHOLD', 3)));
}

function baseDelayMs(): number {
  return envNumber('FLOOM_SIGNIN_PROGRESSIVE_DELAY_BASE_MS', 1000);
}

function maxDelayMs(): number {
  return envNumber('FLOOM_SIGNIN_PROGRESSIVE_DELAY_MAX_MS', 32_000);
}

export function makeSigninProgressiveKey(email: string, ip: string): string {
  return `${email.trim().toLowerCase()}\0${ip}`;
}

function maybeSweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, entry] of store) {
    if (now - entry.lastActivityAt > STALE_ENTRY_MS) store.delete(key);
  }
}

function getOrRehydrateEntry(key: string, now: number): Entry {
  maybeSweep(now);
  const e = store.get(key);
  if (e && now - e.lastActivityAt > STALE_ENTRY_MS) {
    e.consecutiveFailures = 0;
  }
  if (!e) {
    const next: Entry = { consecutiveFailures: 0, lastActivityAt: now };
    store.set(key, next);
    return next;
  }
  e.lastActivityAt = now;
  return e;
}

/**
 * Exponential back-off: after `threshold` consecutive failures, delay
 * `baseMs * 2^(failures - threshold)`, capped at `maxMs`.
 * First delayed failure uses exponent 0 → `baseMs` (e.g. 1s when base=1000).
 */
export function computeProgressiveSigninDelayMs(
  consecutiveFailuresBeforeAttempt: number,
  threshold: number = defaultProgressiveDelayThreshold(),
  baseMs: number = baseDelayMs(),
  maxMs: number = maxDelayMs(),
): number {
  if (consecutiveFailuresBeforeAttempt < threshold) return 0;
  const exp = consecutiveFailuresBeforeAttempt - threshold;
  if (exp < 0) return 0;
  if (exp > 30) return maxMs; // avoid overflow
  const raw = baseMs * 2 ** exp;
  return Math.min(maxMs, Math.floor(raw));
}

/**
 * Await the delay for a pre-built (email, IP) key. Used by the auth route
 * and stress tests (no Hono context).
 */
export async function applyProgressiveSigninDelayForKey(key: string): Promise<void> {
  if (!isProgressiveSigninDelayEnabled()) return;
  const now = Date.now();
  const entry = getOrRehydrateEntry(key, now);
  const delayMs = computeProgressiveSigninDelayMs(entry.consecutiveFailures);
  if (delayMs > 0) await sleep(delayMs);
}

/**
 * Await the delay that should be applied *before* handling this sign-in attempt.
 * Uses current stored failure count for the (email, IP) key.
 */
export async function applyProgressiveSigninDelayFromContext(
  c: Context,
  normalizedEmail: string,
): Promise<void> {
  if (!isProgressiveSigninDelayEnabled() || hasValidAdminBearer(c)) return;
  await applyProgressiveSigninDelayForKey(makeSigninProgressiveKey(normalizedEmail, extractIp(c)));
}

const CREDENTIAL_GUESS_CODES = new Set<string>([
  'INVALID_CREDENTIALS',
  'INVALID_EMAIL_OR_PASSWORD',
  'INVALID_PASSWORD',
  'USER_NOT_FOUND',
  'ACCOUNT_NOT_FOUND',
]);

function isCredentialGuessFailure(
  status: number,
  body: Record<string, unknown> | null,
): boolean {
  if (status === 401) return true;
  if (!body) return false;
  const code = body.code;
  if (typeof code === 'string' && CREDENTIAL_GUESS_CODES.has(code)) return true;
  return false;
}

/**
 * After Better Auth returns, update the failure counter for a key. Exported
 * for stress tests.
 */
export async function recordSigninProgressiveDelayOutcomeForKey(
  key: string,
  res: Response,
): Promise<void> {
  if (!isProgressiveSigninDelayEnabled()) return;
  const now = Date.now();
  const entry = getOrRehydrateEntry(key, now);
  const contentType = res.headers.get('content-type') || '';
  let json: Record<string, unknown> | null = null;
  if (contentType.toLowerCase().includes('application/json')) {
    const text = await res.clone().text().catch(() => '');
    if (text) {
      try {
        const p = JSON.parse(text) as unknown;
        if (p && typeof p === 'object' && !Array.isArray(p)) json = p as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
  }
  if (res.status >= 200 && res.status < 300) {
    entry.consecutiveFailures = 0;
    return;
  }
  if (isCredentialGuessFailure(res.status, json)) {
    entry.consecutiveFailures += 1;
  }
  // EMAIL_NOT_VERIFIED, validation, etc. — do not count or reset (anti-abuse/UX)
}

/**
 * After Better Auth returns, update the failure counter. Same 2xx/4xx
 * response bodies to the client — this only touches in-memory state.
 */
export async function recordSigninEmailProgressiveDelayOutcome(
  c: Context,
  normalizedEmail: string,
  res: Response,
): Promise<void> {
  if (!isProgressiveSigninDelayEnabled() || hasValidAdminBearer(c)) return;
  await recordSigninProgressiveDelayOutcomeForKey(
    makeSigninProgressiveKey(normalizedEmail, extractIp(c)),
    res,
  );
}

/**
 * Parse `email` from a JSON sign-in request body. Returns normalized email or
 * null when missing/invalid.
 */
export function parseEmailForSigninProgressiveDelay(bodyText: string): string | null {
  try {
    const j = JSON.parse(bodyText) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const e = (j as { email?: unknown }).email;
    if (typeof e !== 'string' || !e.trim()) return null;
    return e.trim().toLowerCase();
  } catch {
    return null;
  }
}

/** @internal */
export function __resetSigninProgressiveDelayForTests(): void {
  store.clear();
  lastSweep = 0;
}
