// Rate-limit-then-BYOK gate for the 3 launch demo apps.
//
// Launch-week product rule (2026-04-21):
//   First 5 anonymous runs per IP per 24h on lead-scorer / competitor-analyzer
//   / resume-screener → Floom pays. After that, the caller must supply their
//   own Gemini API key (bring-your-own-key) via X-User-Api-Key. The server
//   injects it for that one run only; we never log or persist user keys.
//
// Why 3 slugs only: these are the 3 hero demo apps that actually consume
// GEMINI_API_KEY. Every other app on Floom either has its own creator-owned
// key or is auth-gated, so the generic run rate-limit is enough.
//
// Why in-memory: preview runs one replica behind one nginx. A Map is fine for
// launch. If/when Floom goes multi-replica, swap for Redis.
//
// Why separate from lib/rate-limit.ts: that module enforces throughput
// budgets (X-RateLimit-*) and returns a generic 429 rate_limit_exceeded.
// This module enforces a *product* rule — "5 free runs then BYOK" — with a
// different 429 payload (`byok_required`) that the web UI catches to show
// a key-input modal. Mixing the two inside lib/rate-limit.ts would couple
// the generic throughput cap to launch-demo curation, which is exactly the
// kind of coupling that bites later.

/** Slugs that are free for 5 anon runs per IP per 24h, then require BYOK. */
export const BYOK_GATED_SLUGS: readonly string[] = [
  'lead-scorer',
  'competitor-analyzer',
  'resume-screener',
];

const WINDOW_MS = 24 * 60 * 60 * 1000;
const FREE_RUNS_PER_IP_PER_DAY = 5;

/**
 * Map of `${ip}:${slug}` → list of run timestamps (ms) in the current
 * rolling window. We prune on every check; no background sweeper needed.
 * Per-slug keys so a user who exhausts lead-scorer still has 5 free runs
 * on competitor-analyzer (each demo has its own budget).
 */
const runsByIpSlug = new Map<string, number[]>();

/** Tests only. Never call from production code. */
export function __resetByokGateForTests(): void {
  runsByIpSlug.clear();
}

export function isByokGated(slug: string): boolean {
  return BYOK_GATED_SLUGS.includes(slug);
}

/**
 * Return the count of runs this IP has used for this slug in the last 24h.
 * Pruning happens inline. Safe to call without recording.
 */
export function peekUsage(ip: string, slug: string, now: number = Date.now()): number {
  const key = `${ip}:${slug}`;
  const list = runsByIpSlug.get(key);
  if (!list) return 0;
  const cutoff = now - WINDOW_MS;
  const pruned = list.filter((t) => t >= cutoff);
  if (pruned.length === 0) {
    runsByIpSlug.delete(key);
    return 0;
  }
  if (pruned.length !== list.length) {
    runsByIpSlug.set(key, pruned);
  }
  return pruned.length;
}

/**
 * Record a free (Floom-paid) run for this IP+slug and return the new count.
 * Only call this AFTER deciding that the caller is consuming free quota
 * (i.e. they did NOT provide an X-User-Api-Key). BYOK runs don't count
 * against the free budget.
 */
export function recordFreeRun(ip: string, slug: string, now: number = Date.now()): number {
  const key = `${ip}:${slug}`;
  const list = runsByIpSlug.get(key) ?? [];
  const cutoff = now - WINDOW_MS;
  const pruned = list.filter((t) => t >= cutoff);
  pruned.push(now);
  runsByIpSlug.set(key, pruned);
  return pruned.length;
}

export interface ByokDecision {
  /** true → block the run with a 429 byok_required payload. */
  block: boolean;
  /** Current free-run count in the 24h window, BEFORE this run is counted. */
  usage: number;
  /** Always FREE_RUNS_PER_IP_PER_DAY (5). Exposed so the client can show "3/5 free runs left". */
  limit: number;
}

/**
 * Decide whether the caller can run the gated app for free right now.
 *
 *   - hasUserKey=true  → always allow, never records against quota.
 *   - hasUserKey=false → allow if usage < 5; block (byok_required) otherwise.
 */
export function decideByok(
  ip: string,
  slug: string,
  hasUserKey: boolean,
  now: number = Date.now(),
): ByokDecision {
  const usage = peekUsage(ip, slug, now);
  if (hasUserKey) {
    return { block: false, usage, limit: FREE_RUNS_PER_IP_PER_DAY };
  }
  return {
    block: usage >= FREE_RUNS_PER_IP_PER_DAY,
    usage,
    limit: FREE_RUNS_PER_IP_PER_DAY,
  };
}

/** Stable payload shape consumed by the web client to trigger the BYOK modal. */
export function byokRequiredResponse(slug: string, usage: number, limit: number) {
  return {
    error: 'byok_required',
    message: 'Free runs used up. Add your Gemini API key to keep going.',
    get_key_url: 'https://aistudio.google.com/app/apikey',
    slug,
    usage,
    limit,
  };
}
