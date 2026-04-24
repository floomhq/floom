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
 *
 * Self-host bypass (2026-04-22, Federico: "apps don't load on local
 * Docker"): this curation is specifically for the hosted floom.dev /
 * preview.floom.dev launch storefront. On a self-hosted Floom instance
 * (cloud_mode === false server-side, surfaced via `/api/session/me`)
 * the allowlist is bypassed entirely — the operator sees every app
 * they've ingested, seeded, or published, minus test fixtures. Without
 * this carve-out a fresh self-host box renders "0 apps" on /apps even
 * though the 7 fast-apps utility sidecar and any ingested apps are
 * healthy and callable by permalink. The empty grid reads as a broken
 * install.
 */
// 2026-04-25 roster swap: previous lead-scorer / competitor-analyzer /
// resume-screener could run 30s-5min on real inputs. Replaced with
// bounded <5s apps. The old slugs still live in examples/ and on the
// DB (as inactive rows), but are off the showcase allowlist.
const SHOWCASE_SLUGS = new Set<string>([
  'competitor-lens',
  'ai-readiness-audit',
  'pitch-coach',
]);

export interface HubFilterOptions {
  /**
   * True when the frontend is rendered from a self-hosted Floom
   * instance (server reports `cloud_mode: false` on `/api/session/me`).
   * Bypasses the SHOWCASE allowlist so the operator sees every app on
   * their instance — the allowlist is a floom.dev-only launch-week
   * curation and hiding the operator's own apps is never what they
   * want. Test fixtures are still filtered regardless of mode.
   */
  selfHost?: boolean;
}

export function isPubliclyListed(
  app: HubApp,
  opts: HubFilterOptions = {},
): boolean {
  if (isTestFixture(app)) return false;
  if (opts.selfHost) return true;
  return SHOWCASE_SLUGS.has(app.slug);
}

/**
 * Public-facing hub list. Default (hosted floom.dev) behavior: the
 * three showcase demos only. On self-host (`opts.selfHost === true`):
 * everything except test fixtures, so the operator's fast-apps and
 * ingested apps render on landing + /apps.
 *
 * Direct permalinks (`/p/:slug`) resolve regardless of this filter —
 * it only governs what the public grid / landing shows.
 */
export function publicHubApps(
  apps: HubApp[],
  opts: HubFilterOptions = {},
): HubApp[] {
  return apps.filter((a) => isPubliclyListed(a, opts));
}
