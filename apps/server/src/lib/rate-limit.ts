// In-memory sliding-window rate limiter for Floom run surfaces.
// Enforces three budgets per run: per-IP anon, per-user authed, per-(IP,
// app). Plus a separate per-user/IP cap on the MCP `ingest_app` tool.
//
// Storage: process-local Map, resets on restart. Good enough for
// single-replica preview. TODO: swap for Redis when Floom goes multi-replica.
// Window: two weighted half-buckets. Node is single-threaded so the read-
// modify-write is atomic per tick — safe under concurrent requests.
// Escape: FLOOM_RATE_LIMIT_DISABLED=true skips every check.

import type { Context, MiddlewareHandler } from 'hono';
import type { SessionContext } from '../types.js';
import { recordRateLimitHit } from './metrics-counters.js';

type Scope = 'ip' | 'user' | 'app' | 'mcp_ingest';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const isRateLimitDisabled = (): boolean =>
  process.env.FLOOM_RATE_LIMIT_DISABLED === 'true';
// Defaults bumped 2026-04-19 (issue #128): prior 20/200/50 were too tight for
// headless/integration/CI use and NAT'd offices. Anon 60/hr per IP covers a
// small team sharing an egress IP plus normal browser usage; authed 300/hr
// per user rewards sign-in with 5× anon headroom; per-(IP, app) 500/hr stops
// a single slug from monopolizing the process while still allowing bursty
// automations.
export const defaultAnonPerHour = (): number =>
  envNumber('FLOOM_RATE_LIMIT_IP_PER_HOUR', 60);
export const defaultUserPerHour = (): number =>
  envNumber('FLOOM_RATE_LIMIT_USER_PER_HOUR', 300);
export const defaultPerAppPerHour = (): number =>
  envNumber('FLOOM_RATE_LIMIT_APP_PER_HOUR', 500);
export const defaultMcpIngestPerDay = (): number =>
  envNumber('FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY', 10);

// ---------- sliding-window store ----------

interface WindowEntry {
  currentStart: number;
  currentCount: number;
  previousCount: number;
  windowMs: number;
}

const store = new Map<string, WindowEntry>();
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Reset the store. Exported for tests; not used in production. */
export function __resetStoreForTests(): void {
  store.clear();
  lastSweep = 0;
}

function maybeSweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, entry] of store) {
    if (now - entry.currentStart > entry.windowMs * 2) store.delete(key);
  }
}

interface CheckResult {
  allowed: boolean;
  retryAfterSec: number;
  /** Effective count within the current sliding window. */
  count: number;
  /** Weighted-window budget remaining after this increment. Never negative. */
  remaining: number;
  /** Epoch seconds when the current window's earliest activity rolls off. */
  resetAt: number;
}

function incrementAndCheck(
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): CheckResult {
  maybeSweep(now);
  const halfMs = windowMs / 2;
  const entry = store.get(key);

  if (!entry) {
    store.set(key, {
      currentStart: now,
      currentCount: 1,
      previousCount: 0,
      windowMs,
    });
    const allowed = 1 <= limit;
    return {
      allowed,
      retryAfterSec: allowed ? 0 : Math.ceil(windowMs / 1000),
      count: 1,
      remaining: Math.max(0, limit - 1),
      resetAt: Math.ceil((now + windowMs) / 1000),
    };
  }

  const elapsed = now - entry.currentStart;
  if (elapsed >= halfMs) {
    // Advance: current → previous; skip idle half-windows. Idle >= full
    // window wipes both halves.
    const halves = Math.floor(elapsed / halfMs);
    entry.previousCount = halves >= 2 ? 0 : entry.currentCount;
    entry.currentCount = 0;
    entry.currentStart = entry.currentStart + halves * halfMs;
  }
  entry.currentCount += 1;

  // Weighted slide: previous half decays linearly across the current half.
  const weight = Math.max(0, 1 - (now - entry.currentStart) / halfMs);
  const count = entry.currentCount + Math.floor(entry.previousCount * weight);
  const resetAt = Math.ceil((entry.currentStart + windowMs) / 1000);

  if (count <= limit) {
    return {
      allowed: true,
      retryAfterSec: 0,
      count,
      remaining: Math.max(0, limit - count),
      resetAt,
    };
  }
  const retryAfterMs = Math.max(1000, entry.currentStart + windowMs - now);
  return {
    allowed: false,
    retryAfterSec: Math.ceil(retryAfterMs / 1000),
    count,
    remaining: 0,
    resetAt,
  };
}

// ---------- key extraction ----------

/** Caller IP: cf-connecting-ip > first x-forwarded-for entry > x-real-ip. */
export function extractIp(c: Context): string {
  const cf = c.req.header('cf-connecting-ip');
  if (cf?.length) return cf.trim();
  const xff = c.req.header('x-forwarded-for');
  if (xff?.length) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header('x-real-ip');
  if (real?.length) return real.trim();
  return 'unknown';
}

// ---------- response helpers ----------

function rateLimitResponse(
  c: Context,
  scope: Scope,
  result: CheckResult,
  limit: number,
): Response {
  recordRateLimitHit(scope);
  return c.json(
    {
      error: 'rate_limit_exceeded',
      retry_after_seconds: result.retryAfterSec,
      scope,
    },
    429,
    {
      'Retry-After': String(result.retryAfterSec),
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(result.resetAt),
      'X-RateLimit-Scope': scope,
    },
  );
}

/**
 * Attach X-RateLimit-* headers to a successful response so clients can back
 * off pre-emptively. Hono sets response headers on `c.header()` before the
 * handler returns; it's safe to call from middleware prior to `next()`.
 */
function applyLimitHeaders(
  c: Context,
  result: CheckResult,
  limit: number,
  scope: Scope,
): void {
  c.header('X-RateLimit-Limit', String(limit));
  c.header('X-RateLimit-Remaining', String(result.remaining));
  c.header('X-RateLimit-Reset', String(result.resetAt));
  c.header('X-RateLimit-Scope', scope);
}

// ---------- middleware ----------

/**
 * Single middleware covering anon + authed + per-app caps. `resolveCtx` is
 * injected so tests can pass a cheap stub instead of pulling in the real
 * Better Auth lookup.
 */
export function runRateLimitMiddleware(
  resolveCtx: (c: Context) => Promise<SessionContext>,
): MiddlewareHandler {
  return async (c, next) => {
    if (isRateLimitDisabled()) return next();
    const now = Date.now();
    const windowMs = 3600 * 1000;
    const ip = extractIp(c);
    const ctx = await resolveCtx(c);

    // Authed → user bucket (higher cap). Anon → IP bucket.
    const primaryKey = ctx.is_authenticated ? `user:${ctx.user_id}` : `ip:${ip}`;
    const primaryCap = ctx.is_authenticated
      ? defaultUserPerHour()
      : defaultAnonPerHour();
    const primaryScope: Scope = ctx.is_authenticated ? 'user' : 'ip';
    const p = incrementAndCheck(primaryKey, primaryCap, windowMs, now);
    if (!p.allowed) return rateLimitResponse(c, primaryScope, p, primaryCap);

    // Per-(IP, app) cap applies in both auth states.
    const slug = c.req.param('slug');
    if (slug) {
      const appCap = defaultPerAppPerHour();
      const r = incrementAndCheck(`app:${ip}:${slug}`, appCap, windowMs, now);
      if (!r.allowed) return rateLimitResponse(c, 'app', r, appCap);
      // Advertise the *tightest* remaining budget so a well-behaved client
      // paces itself against whichever bucket will trip first. Primary vs
      // per-app: pick the smaller remaining.
      if (r.remaining < p.remaining) applyLimitHeaders(c, r, appCap, 'app');
      else applyLimitHeaders(c, p, primaryCap, primaryScope);
    } else {
      applyLimitHeaders(c, p, primaryCap, primaryScope);
    }
    return next();
  };
}

/**
 * MCP `ingest_app` limit. Not a middleware because the MCP layer needs to
 * surface the error inside a JSON-RPC tool envelope, not as a top-level HTTP
 * 429. Per-user when authed, per-IP otherwise.
 */
export function checkMcpIngestLimit(
  ctx: SessionContext,
  ip: string,
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  if (isRateLimitDisabled()) return { allowed: true };
  const key = ctx.is_authenticated
    ? `mcp_ingest:user:${ctx.user_id}`
    : `mcp_ingest:ip:${ip}`;
  const windowMs = 24 * 3600 * 1000;
  const r = incrementAndCheck(key, defaultMcpIngestPerDay(), windowMs, Date.now());
  if (!r.allowed) recordRateLimitHit('mcp_ingest');
  return r.allowed
    ? { allowed: true }
    : { allowed: false, retryAfterSec: r.retryAfterSec };
}
