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
//
// Hardening (2026-04-23, CSO P1-2): pure IP keying was bypassable via IPv6
// /64 rotation, Tor, or a residential proxy pool. Defense-in-depth layers
// added here (NOT a silver bullet — a determined attacker with a real proxy
// pool plus UA rotation can still exhaust; if that becomes a measured abuse
// vector we'll front the demos with Cloudflare Turnstile or an anti-bot
// service):
//   1. Counter is now keyed by `ip + hash(UA)` so two humans behind the
//      same NAT with different browsers get separate 5-run budgets.
//   2. Subnet burst detector: when we see more than
//      SUBNET_BURST_THRESHOLD distinct IPs within a /24 (IPv4) or /48
//      (IPv6) requesting the same slug inside SUBNET_BURST_WINDOW_MS, we
//      mark that prefix as "under burst" and tighten its per-(ip,ua,slug)
//      budget to 1 free run until the burst window rolls off. This catches
//      the common residential-proxy / consumer-IPv6 attack shape without
//      punishing legit office networks (which almost never see >10 fresh
//      IPs in 60s hitting a demo app).

import { createHash } from 'node:crypto';

/** Slugs that are free for 5 anon runs per IP per 24h, then require BYOK. */
export const BYOK_GATED_SLUGS: readonly string[] = [
  'lead-scorer',
  'competitor-analyzer',
  'resume-screener',
];

const WINDOW_MS = 24 * 60 * 60 * 1000;
const FREE_RUNS_PER_IP_PER_DAY = 5;

// Subnet burst detector knobs. Triggered only for anon free runs on the
// gated slugs; authenticated / BYOK callers bypass entirely.
const SUBNET_BURST_WINDOW_MS = 60 * 1000; // 60s rolling window
const SUBNET_BURST_THRESHOLD = 10; // >10 distinct IPs/min from one prefix
const SUBNET_BURST_COOLDOWN_MS = 15 * 60 * 1000; // tighten for 15 minutes
const BURST_TIGHTENED_FREE_RUNS = 1; // during burst: 1 free run, not 5

/**
 * Map of `${ip}:${uaHash}:${slug}` → list of run timestamps (ms) in the
 * current rolling window. We prune on every check; no background sweeper
 * needed. Per-slug keys so a user who exhausts lead-scorer still has 5
 * free runs on competitor-analyzer (each demo has its own budget).
 */
const runsByIpSlug = new Map<string, number[]>();

/**
 * Map of `${prefix}:${slug}` → list of {ip, ts} seen recently. Prefix is
 * the /24 for IPv4, /48 for IPv6. Used to detect bursts of fresh IPs from
 * one network segment.
 */
const subnetSightings = new Map<string, Array<{ ip: string; ts: number }>>();

/** Tests only. Never call from production code. */
export function __resetByokGateForTests(): void {
  runsByIpSlug.clear();
  subnetSightings.clear();
}

/**
 * Short stable hash of the caller's User-Agent. Empty/missing UAs collapse
 * to a single bucket (still counted, just shared — we'd rather under-count
 * than accidentally isolate every no-UA request into its own bucket and
 * hand out unlimited runs). 10 hex chars = ~40 bits, enough for per-IP
 * bucketing without becoming a tracking surface.
 */
export function hashUserAgent(ua: string | null | undefined): string {
  const raw = (ua || '').trim();
  return createHash('sha256').update(`byok-ua-v1:${raw}`).digest('hex').slice(0, 10);
}

/**
 * Return the /24 (IPv4) or /48 (IPv6) network prefix of the caller. Used
 * to detect distributed abuse across a single consumer ISP allocation.
 * Falls back to the raw ip string if we can't parse it.
 */
export function ipPrefix(ip: string): string {
  if (!ip || ip === 'unknown') return ip || 'unknown';
  // IPv4: keep first 3 octets → /24
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  // IPv6: keep first 3 hextets → /48 (carrier/subscriber allocation size)
  if (ip.includes(':')) {
    // Normalize by splitting on `::` once if present; we don't need to
    // fully expand, just grab the first 3 groups as typed.
    const head = ip.split('::')[0];
    const groups = head.split(':').filter(Boolean).slice(0, 3);
    if (groups.length === 3) return `${groups.join(':')}::/48`;
    return `${ip}/128`;
  }
  return ip;
}

/**
 * Record that this IP hit this slug and return true if the parent /24 or
 * /48 is currently in a burst state (>SUBNET_BURST_THRESHOLD distinct IPs
 * in the last SUBNET_BURST_WINDOW_MS). Called inline from peekUsage /
 * recordFreeRun; no side effects beyond bookkeeping.
 */
function noteSightingAndCheckBurst(ip: string, slug: string, now: number): boolean {
  const prefix = ipPrefix(ip);
  const key = `${prefix}:${slug}`;
  const cutoff = now - SUBNET_BURST_WINDOW_MS;
  const list = (subnetSightings.get(key) || []).filter((s) => s.ts >= cutoff);
  // Only add if this IP isn't already in the window (we want distinct IPs).
  if (!list.some((s) => s.ip === ip)) {
    list.push({ ip, ts: now });
  }
  subnetSightings.set(key, list);
  // Extended cooldown: if we ever crossed the threshold in the last
  // SUBNET_BURST_COOLDOWN_MS, stay tightened even after the raw burst
  // window rolled off. That stops the "1 fresh IP every 61s" evasion.
  const cooldownCutoff = now - SUBNET_BURST_COOLDOWN_MS;
  const recentSightings = (subnetSightings.get(key) || []).filter(
    (s) => s.ts >= cooldownCutoff,
  );
  const distinct = new Set(recentSightings.map((s) => s.ip));
  return distinct.size > SUBNET_BURST_THRESHOLD;
}

/** Test helper: inspect whether a prefix is currently flagged as bursting. */
export function __isSubnetBurstingForTests(ip: string, slug: string, now: number = Date.now()): boolean {
  return noteSightingAndCheckBurst(ip, slug, now);
}

export function isByokGated(slug: string): boolean {
  return BYOK_GATED_SLUGS.includes(slug);
}

/**
 * Build the lookup key for the per-(ip, ua, slug) counter. UA is hashed to
 * avoid storing raw UA strings in memory. Legacy callers that don't pass
 * uaHash (tests, older code paths) fall through to the pre-hardening
 * behavior, which is IP+slug only — equivalent to a single shared UA
 * bucket. That is deliberately backward-compatible so old tests keep
 * asserting the core semantics.
 */
function bucketKey(ip: string, uaHash: string | undefined, slug: string): string {
  return uaHash ? `${ip}:${uaHash}:${slug}` : `${ip}:${slug}`;
}

/**
 * Return the count of runs this (IP, UA) has used for this slug in the
 * last 24h. Pruning happens inline. Safe to call without recording.
 *
 * `uaHash` is optional for backward compatibility; new callers should
 * pass `hashUserAgent(c.req.header('user-agent'))`.
 */
export function peekUsage(
  ip: string,
  slug: string,
  now: number = Date.now(),
  uaHash?: string,
): number {
  const key = bucketKey(ip, uaHash, slug);
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
 * Record a free (Floom-paid) run for this (IP, UA)+slug and return the new
 * count. Only call this AFTER deciding that the caller is consuming free
 * quota (i.e. they did NOT provide an X-User-Api-Key). BYOK runs don't
 * count against the free budget.
 */
export function recordFreeRun(
  ip: string,
  slug: string,
  now: number = Date.now(),
  uaHash?: string,
): number {
  const key = bucketKey(ip, uaHash, slug);
  const list = runsByIpSlug.get(key) ?? [];
  const cutoff = now - WINDOW_MS;
  const pruned = list.filter((t) => t >= cutoff);
  pruned.push(now);
  runsByIpSlug.set(key, pruned);
  // Record the sighting so the subnet-burst detector sees the traffic
  // shape even on BYOK-gated accept paths. The detector is read by
  // decideByok to tighten the limit.
  noteSightingAndCheckBurst(ip, slug, now);
  return pruned.length;
}

export interface ByokDecision {
  /** true → block the run with a 429 byok_required payload. */
  block: boolean;
  /** Current free-run count in the 24h window, BEFORE this run is counted. */
  usage: number;
  /**
   * Effective limit for this caller right now. Normally
   * FREE_RUNS_PER_IP_PER_DAY (5), but drops to BURST_TIGHTENED_FREE_RUNS
   * (1) when the caller's /24 or /48 is under burst. The client uses
   * this to render "N/M free runs left" correctly.
   */
  limit: number;
  /**
   * true → we tightened the limit because the parent subnet is under a
   * burst. Surfaced for ops observability (logged in run.ts), not shown
   * to the user.
   */
  tightened?: boolean;
}

/**
 * Decide whether the caller can run the gated app for free right now.
 *
 *   - hasUserKey=true  → always allow, never records against quota.
 *   - hasUserKey=false → allow if usage < effective limit; block otherwise.
 *
 * `uaHash` (new, optional) is the short stable hash of the caller's
 * User-Agent. Older call sites that don't pass it still work under the
 * pre-hardening semantics.
 */
export function decideByok(
  ip: string,
  slug: string,
  hasUserKey: boolean,
  now: number = Date.now(),
  uaHash?: string,
): ByokDecision {
  const usage = peekUsage(ip, slug, now, uaHash);
  if (hasUserKey) {
    return { block: false, usage, limit: FREE_RUNS_PER_IP_PER_DAY };
  }
  // Check subnet burst without recording a sighting — we only want to
  // record sightings on actual free-run accepts (recordFreeRun). Here we
  // just read the current state.
  const tightened = isPrefixBursting(ip, slug, now);
  const effectiveLimit = tightened ? BURST_TIGHTENED_FREE_RUNS : FREE_RUNS_PER_IP_PER_DAY;
  return {
    block: usage >= effectiveLimit,
    usage,
    limit: effectiveLimit,
    ...(tightened ? { tightened: true } : {}),
  };
}

/** Read-only burst check — does NOT record a new sighting. */
function isPrefixBursting(ip: string, slug: string, now: number): boolean {
  const prefix = ipPrefix(ip);
  const key = `${prefix}:${slug}`;
  const cooldownCutoff = now - SUBNET_BURST_COOLDOWN_MS;
  const recent = (subnetSightings.get(key) || []).filter((s) => s.ts >= cooldownCutoff);
  if (recent.length !== (subnetSightings.get(key) || []).length) {
    // Prune while we're here.
    if (recent.length === 0) subnetSightings.delete(key);
    else subnetSightings.set(key, recent);
  }
  const distinct = new Set(recent.map((s) => s.ip));
  return distinct.size > SUBNET_BURST_THRESHOLD;
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
