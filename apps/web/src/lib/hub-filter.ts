import type { HubApp } from './types';

/**
 * Slugs and descriptions that match these patterns are QA/test fixtures
 * produced by the e2e suite and the OpenAPI detect fallback. They ship to
 * the backend (harmless) but must never appear in the public /apps
 * directory, or in the "N apps running right now" stat on the landing
 * page, because a fresh consumer sees "Swagger Petstore" or "Renderer
 * Test" and loses trust.
 *
 * Single source of truth so the landing hero count and the /apps header
 * count never drift. See fix/ui-surgical-2026-04-18 (bug 2).
 */
const TEST_FIXTURE_SLUG = /^(swagger-petstore|stopwatch-\d|e2e-stopwatch|my-renderer-test)/i;
const TEST_FIXTURE_DESC =
  /^(This is a sample Pet Store Server|GitHub's v3 REST API\.|A simple HTTP Request & Response Service)/i;

export function isTestFixture(app: HubApp): boolean {
  if (TEST_FIXTURE_SLUG.test(app.slug)) return true;
  if (app.description && TEST_FIXTURE_DESC.test(app.description)) return true;
  return false;
}

/**
 * P0 launch curation (issue #252, 2026-04-21): the public landing +
 * /apps directory must only surface the three showcase demos. The
 * backend still returns all ~42 rows (we don't delete DB rows —
 * installs from MCP, deep-link shares, /p/:slug permalinks, and the
 * InlineDemo hitting /api/run for `uuid` still resolve), but public
 * listings are allowlisted here.
 *
 * 2026-04-21 follow-up (Federico: "just the three demos for now, keep
 * it clean"): cut the first-party utility carve-out that used to also
 * surface uuid / base64 / hash / jwt-decode / password / json-format /
 * word-count. Those apps remain reachable by direct slug/permalink,
 * just no longer listed on landing or /apps.
 *
 * Anything outside this allowlist is hidden from:
 *   - landing hero tiles + featured stripes
 *   - landing "N apps running now" count
 *   - /apps directory grid + search
 *
 * To re-surface an app publicly, add it to SHOWCASE_SLUGS. The
 * `featured` DB flag no longer grants public listing on its own.
 */
const SHOWCASE_SLUGS = new Set<string>([
  'lead-scorer',
  'competitor-analyzer',
  'resume-screener',
]);

export function isPubliclyListed(app: HubApp): boolean {
  if (isTestFixture(app)) return false;
  return SHOWCASE_SLUGS.has(app.slug);
}

/**
 * Public-facing hub list: the three showcase demos only. Every other
 * app is hidden from landing + /apps until explicitly allowlisted
 * (SHOWCASE_SLUGS). Direct permalinks (/p/:slug) still resolve.
 */
export function publicHubApps(apps: HubApp[]): HubApp[] {
  return apps.filter(isPubliclyListed);
}
