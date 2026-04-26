// Server-side mirror of apps/web/src/lib/hub-filter.ts.
//
// Public hub curation mirror for apps/web/src/lib/hub-filter.ts.
//
// Launch mode keeps the hosted public roster to the 3 showcase apps plus
// the 7 utility apps. Fixture filtering always stays on by default because
// QA / E2E / PRR rows get ingested by automated tests and must never leak
// out of /api/hub or MCP list/search surfaces.
//
// Issue #144 (2026-04-20): the web `/apps` directory filtered these
// client-side via `apps/web/src/lib/hub-filter.ts`, but raw API + MCP
// callers saw all 37 apps including 15 fixtures. Moving the filter to
// the server closes that gap.
//
// Keep this regex list in sync with the web-side copy. The web filter
// stays as defense-in-depth — if a new fixture pattern ships before the
// server regex is updated, the web /apps grid still hides it.

export interface HubFilterApp {
  slug: string;
  description?: string | null;
}

export const SHOWCASE_SLUGS = new Set<string>([
  'competitor-lens',
  'ai-readiness-audit',
  'pitch-coach',
]);

export const BROWSE_SLUGS = new Set<string>([
  'json-format',
  'uuid',
  'jwt-decode',
  'password',
  'hash',
  'base64',
  'word-count',
]);

export const LAUNCH_LISTED_SLUGS = new Set<string>([
  ...SHOWCASE_SLUGS,
  ...BROWSE_SLUGS,
]);

// Slug prefixes used by test fixtures. Case-insensitive.
//   swagger-petstore*              — OpenAPI detect fallback (sample spec)
//   stopwatch-<digits>             — renderer E2E (legacy)
//   e2e-stopwatch-*                — renderer E2E (current)
//   e2e-prr-*                      — post-release review fixtures
//   my-renderer-test               — one-off renderer bundler test
//   audit-petstore-*               — nightly audit fixtures
//   petstore-audit-*               — nightly audit fixtures (alt prefix)
//   petstore-public-*              — visibility flip tests
//   uuid-generator-prr-*           — PRR-suite UUID fixtures
export const TEST_FIXTURE_SLUG =
  /^(swagger-petstore|stopwatch-\d|e2e-stopwatch|e2e-prr|my-renderer-test|audit-petstore|petstore-audit|petstore-public|uuid-generator-prr)/i;

// Description preambles used by the public sample specs that people
// accidentally ingest when exploring. These are the verbatim first lines of
// the three most-common example OpenAPI docs (Swagger Petstore, GitHub v3,
// httpbin). If a creator's real app happens to copy these exact openers,
// we'd rather err on the side of hiding — it's fixable by editing the
// description, and the false-positive rate is ~0.
export const TEST_FIXTURE_DESC =
  /^(This is a sample Pet Store Server|GitHub's v3 REST API\.|A simple HTTP Request & Response Service)/i;

export function isTestFixture(app: HubFilterApp): boolean {
  if (TEST_FIXTURE_SLUG.test(app.slug)) return true;
  if (app.description && TEST_FIXTURE_DESC.test(app.description)) return true;
  return false;
}

/**
 * Drop QA/E2E/PRR fixtures from a raw app list.
 *
 * Callers: `GET /api/hub`, MCP `list_apps`, MCP `search_apps`. Everything
 * that surfaces the gallery to a public caller should pass through this.
 * The single-app `GET /api/hub/:slug` and `GET /api/hub/mine` endpoints
 * DO NOT filter — permalinks must keep working, and owners need to see
 * their own half-published drafts.
 */
export function filterTestFixtures<T extends HubFilterApp>(apps: T[]): T[] {
  return apps.filter((a) => !isTestFixture(a));
}

export interface HubFilterOptions {
  selfHost?: boolean;
  includeFixtures?: boolean;
  launchMode?: boolean;
}

export function isLaunchModeEnabled(): boolean {
  return process.env.FLOOM_LAUNCH_MODE === 'true';
}

export function isPubliclyListed(
  app: HubFilterApp,
  opts: HubFilterOptions = {},
): boolean {
  if (!opts.includeFixtures && isTestFixture(app)) return false;
  if (opts.selfHost) return true;
  const launchMode = opts.launchMode ?? isLaunchModeEnabled();
  if (!launchMode) return true;
  return LAUNCH_LISTED_SLUGS.has(app.slug);
}

export function publicHubApps<T extends HubFilterApp>(
  apps: T[],
  opts: HubFilterOptions = {},
): T[] {
  return apps.filter((app) => isPubliclyListed(app, opts));
}
