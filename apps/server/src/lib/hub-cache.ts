// Perf launch-blocker fix (2026-04-20): in-memory cache for GET /api/hub.
//
// Root cause: every GET /api/hub request re-ran the SELECT + parsed up
// to 448KB of manifest JSON across 46 apps (manifests live in the
// `apps.manifest` TEXT column). At c=10 concurrency the handler pegged
// at ~2.5 req/s with p95=15s — unshippable.
//
// Fix: cache the serialized JSON body for 5s per (category, sort,
// includeFixtures) tuple. Apps don't mutate often enough for stale-
// by-5s to matter; every mutation path (POST /ingest, DELETE /:slug,
// PATCH /:slug) and the runner's avg_run_ms refresh call
// `invalidateHubCache()` below so the test suite + creator edits see
// fresh data immediately.
//
// Lives in `lib/` rather than `routes/hub.ts` to avoid a routes→services
// import cycle: `services/runner.ts` also imports invalidateHubCache()
// to bust the cache when it refreshes `apps.avg_run_ms` after a run.

type HubCacheEntry = { body: unknown; expiresAt: number };

const hubCache = new Map<string, HubCacheEntry>();

export const HUB_CACHE_TTL_MS = 5_000;

/**
 * Build a cache key from every query parameter that changes the response.
 * MUST include every discriminator or a `?category=X` request will serve
 * the uncategorized bucket.
 */
export function hubCacheKey(
  category: string | null,
  sort: string,
  includeFixtures: boolean,
): string {
  return `${category ?? ''}|${sort}|${includeFixtures ? '1' : '0'}`;
}

export function getHubCache(key: string): unknown | null {
  const entry = hubCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    hubCache.delete(key);
    return null;
  }
  return entry.body;
}

export function setHubCache(key: string, body: unknown): void {
  hubCache.set(key, { body, expiresAt: Date.now() + HUB_CACHE_TTL_MS });
}

/**
 * Invalidate the hub directory cache. Called by every mutation path
 * (ingest, delete, patch, runner avg_run_ms refresh) so downstream
 * reads see fresh data immediately.
 */
export function invalidateHubCache(): void {
  hubCache.clear();
}
