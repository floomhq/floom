// GET /api/gh-stars — server-side proxy for the floomhq/floom GitHub star
// count. Calls the GitHub REST API with the server's token (when set) and
// caches the result in-memory for 10 minutes so a page-load storm doesn't
// exhaust the GitHub rate budget.
//
// Why this exists:
//   The TopBar <GitHubStarsBadge/> used to fetch api.github.com directly
//   from the browser. GitHub's anonymous REST budget is 60 req/hour/IP,
//   which means the badge got 403-rate-limited on the first page load for
//   most visitors (shared cloud WAFs, office NATs, most adblock lists
//   block or rate-limit api.github.com). The console noise from that
//   failure was visible on every landing load. Moving the fetch server-
//   side lets us:
//     1. Use a PAT (5,000 req/hour authenticated) when FEEDBACK_GITHUB_TOKEN
//        or GITHUB_TOKEN is set.
//     2. Cache the count in-process for 10 minutes so N page loads share
//        one upstream call.
//     3. Return JSON over same-origin, killing CORS / adblock edge cases.
//
// Response shape: `{ count: number, source: "live" | "cache" | "fallback" }`
// We always render a number so the TopBar badge never renders empty.

import { Hono } from 'hono';

export const ghStarsRouter = new Hono();

const REPO = 'floomhq/floom';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REQUEST_TIMEOUT_MS = 4000;
// Conservative floor that matches apps/web's FALLBACK_COUNT. Kept in sync
// at each release so the number is plausible even if every upstream call
// fails. Always underrepresent — better than inflating.
const FALLBACK_COUNT = 60;

interface CacheEntry {
  count: number;
  ts: number;
}

let cache: CacheEntry | null = null;
// In-flight de-duplication: if 50 pages load at once and the cache is
// cold, we still only open ONE upstream fetch.
let inFlight: Promise<number | null> | null = null;

function getToken(): string | undefined {
  // FEEDBACK_GITHUB_TOKEN is the canonical Floom PAT used elsewhere
  // (routes/feedback.ts, lib/feedback-github.ts). GITHUB_TOKEN is the
  // conventional fallback for containers / CI. Either works.
  return process.env.FEEDBACK_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
}

async function fetchFromGitHub(): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'floom-server-stars-proxy',
    };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers,
      signal: controller.signal,
    });
    if (!r.ok) {
      console.warn(
        `[gh-stars] GitHub API responded ${r.status} (token=${token ? 'set' : 'unset'})`,
      );
      return null;
    }
    const body = (await r.json()) as { stargazers_count?: number };
    if (typeof body.stargazers_count !== 'number') return null;
    return body.stargazers_count;
  } catch (err) {
    console.warn('[gh-stars] fetch failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshCache(): Promise<number | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const count = await fetchFromGitHub();
      if (typeof count === 'number') {
        cache = { count, ts: Date.now() };
      }
      return count;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

ghStarsRouter.get('/', async (c) => {
  const now = Date.now();
  const fresh = cache && now - cache.ts < CACHE_TTL_MS;

  // Fast path — serve from cache so a page-load storm pays no upstream cost.
  if (fresh && cache) {
    // Browser cache for 5 minutes, shared cache (CDN) for 10. Even if our
    // in-process cache is flushed on redeploy, a CDN in front of us still
    // shields GitHub from the load.
    c.header('Cache-Control', 'public, max-age=300, s-maxage=600');
    return c.json({ count: cache.count, source: 'cache' as const });
  }

  // Slow path — fetch from upstream. Still cheap; one upstream call at most
  // per TTL thanks to the inFlight de-dupe.
  const live = await refreshCache();
  if (typeof live === 'number') {
    c.header('Cache-Control', 'public, max-age=300, s-maxage=600');
    return c.json({ count: live, source: 'live' as const });
  }

  // Upstream failed. Return stale cache if we have one, else the floor.
  // Always return 200 with a number — the UI should never break.
  if (cache) {
    c.header('Cache-Control', 'public, max-age=60, s-maxage=60');
    return c.json({ count: cache.count, source: 'cache' as const });
  }
  c.header('Cache-Control', 'public, max-age=60, s-maxage=60');
  return c.json({ count: FALLBACK_COUNT, source: 'fallback' as const });
});
