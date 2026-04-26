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
import { hasValidAdminBearer } from './auth.js';
import { extractIp } from './client-ip.js';
import { recordRateLimitHit } from './metrics-counters.js';
import { sendDiscordAlert } from './alerts.js';

type Scope = 'ip' | 'user' | 'app' | 'agent_token' | 'mcp_ingest';

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
//
// Bumped again 2026-04-21 (pre-launch): anon raised 60 → 150 to absorb
// launch-day traffic. Shared NAT IPs (offices, mobile carriers, university
// networks), HN frontpage spikes, and demo embeds on the landing page all
// collapse onto a handful of source IPs, so 60/hr was tripping legitimate
// multi-user traffic. 150 keeps the per-client bucket tight enough to stop
// single-origin abuse while leaving room for 2-3 people behind one IP.
export const defaultAnonPerHour = (): number =>
  envNumber('FLOOM_RATE_LIMIT_IP_PER_HOUR', 150);
export const defaultUserPerHour = (): number =>
  envNumber('FLOOM_RATE_LIMIT_USER_PER_HOUR', 300);
export const defaultPerAppPerHour = (): number =>
  envNumber('FLOOM_RATE_LIMIT_APP_PER_HOUR', 500);
export const defaultMcpIngestPerDay = (): number =>
  envNumber('FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY', 10);
export const defaultWriteAnonPerMinute = (): number =>
  envNumber('FLOOM_WRITE_RATE_LIMIT_IP_PER_MINUTE', 30);
export const defaultWriteUserPerMinute = (): number =>
  envNumber('FLOOM_WRITE_RATE_LIMIT_USER_PER_MINUTE', 60);
export const defaultAgentTokenPerMinute = (): number =>
  envNumber('FLOOM_AGENT_TOKEN_RATE_LIMIT_PER_MINUTE', 60);

// Re-export: historical import path is ../lib/rate-limit.js
export { extractIp } from './client-ip.js';

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

export interface RunRateLimitBlock {
  ok: false;
  status: 429;
  body: {
    error: 'rate_limit_exceeded';
    retry_after_seconds: number;
    scope: Scope;
  };
  headers: Record<string, string>;
}

export type RunRateLimitGateResult = { ok: true } | RunRateLimitBlock;

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

// ---------- response helpers ----------

// Cap the public retry-after at 5 minutes. The sliding window is an hour,
// so on a cold bucket the true "seconds until under limit" can exceed 2500s.
// Telling a user "come back in 46 minutes" looks broken and wastes retries;
// capping at 300s produces a predictable "try again in a few minutes" UX
// while the internal sliding window keeps enforcing the real budget.
const RETRY_AFTER_CLAMP_SEC = 300;

function clampRetryAfter(sec: number): number {
  return Math.min(sec, RETRY_AFTER_CLAMP_SEC);
}

// ---------- abuse alerting ----------
//
// One IP tripping many 429s in a short window is an abuse signal (scraper,
// stuck retry loop, credential-stuffing bot). Track per-IP 429 counts in a
// rolling 5-min window; when a threshold trips, fire one Discord alert and
// debounce for an hour so a sustained attack doesn't spam the channel.
interface AbuseWindow {
  windowStart: number;
  count: number;
  lastAlertAt: number;
}
const abuseStore = new Map<string, AbuseWindow>();
const ABUSE_WINDOW_MS = 5 * 60 * 1000;
const ABUSE_THRESHOLD = 10;
const ABUSE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

function noteRateLimitHitForAbuse(ip: string, scope: Scope, now: number): void {
  // Skip authed-user 429s (misconfigured client, not abuse) and unknown IPs.
  if (scope === 'user') return;
  if (ip === 'unknown') return;
  let entry = abuseStore.get(ip);
  if (!entry || now - entry.windowStart > ABUSE_WINDOW_MS) {
    entry = { windowStart: now, count: 0, lastAlertAt: entry?.lastAlertAt ?? 0 };
    abuseStore.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count >= ABUSE_THRESHOLD && now - entry.lastAlertAt > ABUSE_ALERT_COOLDOWN_MS) {
    entry.lastAlertAt = now;
    // Mask IPv4 last octet; truncate IPv6. Actionable signal without
    // splashing raw PII into Discord.
    const masked = ip.includes('.')
      ? ip.replace(/\.\d+$/, '.xxx')
      : ip.replace(/(:[0-9a-f]+){5,}$/i, ':xxxx');
    sendDiscordAlert(
      'Floom abuse: repeated 429s',
      `IP \`${masked}\` tripped ${entry.count} rate-limits in ${Math.round(ABUSE_WINDOW_MS / 60000)}m.`,
      { scope },
    );
  }
  if (entry.count > 10_000) entry.count = 10_000;
}

/** Reset the abuse store. Exported for tests. */
export function __resetAbuseStoreForTests(): void {
  abuseStore.clear();
}

function buildRateLimitBlock(
  c: Context,
  scope: Scope,
  result: CheckResult,
  limit: number,
): RunRateLimitBlock {
  recordRateLimitHit(scope);
  noteRateLimitHitForAbuse(extractIp(c), scope, Date.now());
  const retryAfter = clampRetryAfter(result.retryAfterSec);
  return {
    ok: false,
    status: 429,
    body: {
      error: 'rate_limit_exceeded',
      retry_after_seconds: retryAfter,
      scope,
    },
    headers: {
      'Retry-After': String(retryAfter),
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(result.resetAt),
      'X-RateLimit-Scope': scope,
    },
  };
}

function writeRateLimitResponse(
  c: Context,
  scope: Scope,
  result: CheckResult,
  limit: number,
): Response {
  recordRateLimitHit(scope);
  noteRateLimitHitForAbuse(extractIp(c), scope, Date.now());
  const retryAfter = clampRetryAfter(result.retryAfterSec);
  return c.json(
    {
      error: 'rate_limit_exceeded',
      retryAfter,
    },
    429,
    {
      'Retry-After': String(retryAfter),
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

function checkAgentTokenLimit(
  ctx: SessionContext,
  now: number,
): { result: CheckResult; limit: number } | null {
  if (!ctx.agent_token_id) return null;
  const limit = ctx.agent_token_rate_limit_per_minute || defaultAgentTokenPerMinute();
  return {
    limit,
    result: incrementAndCheck(
      `agent_token:${ctx.agent_token_id}`,
      limit,
      60 * 1000,
      now,
    ),
  };
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_RATE_LIMIT_SKIP_PATHS = new Set([
  '/api/run',
  '/api/agents/run',
  '/api/hub/ingest',
  '/api/feedback',
  '/api/waitlist',
  '/api/deploy-waitlist',
]);
const WRITE_RATE_LIMIT_SKIP_PATTERNS = [
  /^\/api\/[^/]+\/run\/?$/,
  /^\/api\/[^/]+\/jobs\/?$/,
];

export function isWriteRateLimitSkippedPath(pathname: string): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;
  if (WRITE_RATE_LIMIT_SKIP_PATHS.has(normalized)) return true;
  return WRITE_RATE_LIMIT_SKIP_PATTERNS.some((rx) => rx.test(normalized));
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
    const ctx = await resolveCtx(c);
    const gate = checkRunRateLimit(c, ctx);
    if (!gate.ok) return c.json(gate.body, gate.status, gate.headers);
    return next();
  };
}

export function checkRunRateLimit(
  c: Context,
  ctx: SessionContext,
  slugOverride?: string | null,
): RunRateLimitGateResult {
  if (isRateLimitDisabled()) return { ok: true };
  // Admin bypass (2026-04-21): when FLOOM_AUTH_TOKEN is configured AND
  // the caller presents the matching bearer, skip rate-limit entirely.
  // This unblocks ops sweeps, monitoring, and catalog rebuilds from the
  // server operator without opening the limit up publicly. Returns false
  // when no token is configured, so OSS mode still enforces the caps.
  if (hasValidAdminBearer(c)) return { ok: true };
  const now = Date.now();
  const windowMs = 3600 * 1000;
  const ip = extractIp(c);

  // Authed → user bucket (higher cap). Anon → IP bucket.
  const primaryKey = ctx.is_authenticated ? `user:${ctx.user_id}` : `ip:${ip}`;
  const primaryCap = ctx.is_authenticated
    ? defaultUserPerHour()
    : defaultAnonPerHour();
  const primaryScope: Scope = ctx.is_authenticated ? 'user' : 'ip';
  const p = incrementAndCheck(primaryKey, primaryCap, windowMs, now);
  if (!p.allowed) return buildRateLimitBlock(c, primaryScope, p, primaryCap);
  const agentLimit = checkAgentTokenLimit(ctx, now);
  if (agentLimit && !agentLimit.result.allowed) {
    return buildRateLimitBlock(c, 'agent_token', agentLimit.result, agentLimit.limit);
  }

  // Per-(IP, app) cap applies in both auth states.
  const slug = slugOverride ?? c.req.param('slug');
  if (slug) {
    const appCap = defaultPerAppPerHour();
    const r = incrementAndCheck(`app:${ip}:${slug}`, appCap, windowMs, now);
    if (!r.allowed) return buildRateLimitBlock(c, 'app', r, appCap);
    // Advertise the *tightest* remaining budget so a well-behaved client
    // paces itself against whichever bucket will trip first. Primary vs
    // per-app vs agent token: pick the smaller remaining.
    const advertised = [
      { result: p, limit: primaryCap, scope: primaryScope },
      { result: r, limit: appCap, scope: 'app' as const },
      ...(agentLimit
        ? [
            {
              result: agentLimit.result,
              limit: agentLimit.limit,
              scope: 'agent_token' as const,
            },
          ]
        : []),
    ].sort((a, b) => a.result.remaining - b.result.remaining)[0];
    applyLimitHeaders(c, advertised.result, advertised.limit, advertised.scope);
  } else if (agentLimit && agentLimit.result.remaining < p.remaining) {
    applyLimitHeaders(c, agentLimit.result, agentLimit.limit, 'agent_token');
  } else {
    applyLimitHeaders(c, p, primaryCap, primaryScope);
  }

  return { ok: true };
}

/**
 * Global write limiter for /api/* mutation routes.
 *
 * Default budgets (env-configurable):
 *   - anonymous callers: 30 writes/min per IP
 *   - authed callers: 60 writes/min per user
 *
 * Existing per-route limiters (run surfaces, waitlist, feedback) are skipped
 * to avoid double-throttling.
 */
export function writeRateLimitMiddleware(
  resolveCtx: (c: Context) => Promise<SessionContext>,
): MiddlewareHandler {
  return async (c, next) => {
    if (isRateLimitDisabled()) return next();
    const method = c.req.method.toUpperCase();
    if (!WRITE_METHODS.has(method)) return next();
    const pathname = new URL(c.req.url).pathname;
    if (!pathname.startsWith('/api/')) return next();
    if (isWriteRateLimitSkippedPath(pathname)) return next();
    if (hasValidAdminBearer(c)) return next();

    const now = Date.now();
    const ip = extractIp(c);
    const ctx = await resolveCtx(c);
    const scope: Scope = ctx.is_authenticated ? 'user' : 'ip';
    const limit = ctx.is_authenticated
      ? defaultWriteUserPerMinute()
      : defaultWriteAnonPerMinute();
    const key = ctx.is_authenticated
      ? `write:user:${ctx.user_id}`
      : `write:ip:${ip}`;
    const result = incrementAndCheck(key, limit, 60 * 1000, now);
    if (!result.allowed) {
      return writeRateLimitResponse(c, scope, result, limit);
    }
    const agentLimit = checkAgentTokenLimit(ctx, now);
    if (agentLimit && !agentLimit.result.allowed) {
      return writeRateLimitResponse(c, 'agent_token', agentLimit.result, agentLimit.limit);
    }
    if (agentLimit && agentLimit.result.remaining < result.remaining) {
      applyLimitHeaders(c, agentLimit.result, agentLimit.limit, 'agent_token');
    } else {
      applyLimitHeaders(c, result, limit, scope);
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
  if (ctx.agent_token_id) {
    const tokenLimit = ctx.agent_token_rate_limit_per_minute || defaultAgentTokenPerMinute();
    const tokenResult = incrementAndCheck(
      `agent_token:${ctx.agent_token_id}`,
      tokenLimit,
      60 * 1000,
      Date.now(),
    );
    if (!tokenResult.allowed) {
      recordRateLimitHit('agent_token');
      return { allowed: false, retryAfterSec: tokenResult.retryAfterSec };
    }
  }
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
