#!/usr/bin/env node
// Live regression: /api/hub MUST NOT leak E2E / PRR / audit test
// fixtures (issue #144). Hits the public hub endpoint, asserts no
// known fixture slugs appear in the response, and confirms the
// `?include_fixtures=true` escape hatch still returns them.
//
// Run:  node test/stress/test-hub-fixtures.mjs [base_url]
//   default base_url: https://preview.floom.dev

const BASE = process.argv[2] || 'https://preview.floom.dev';

// Regex-level assertions (not a fixed count — new real apps can be
// published between the fix and the test run; we pin on "no fixtures"
// rather than "exactly 22 apps").
const FIXTURE_PATTERNS = [
  /^swagger-petstore/i,
  /^stopwatch-\d/i,
  /^e2e-stopwatch/i,
  /^e2e-prr/i,
  /^audit-petstore/i,
  /^petstore-audit/i,
  /^petstore-public/i,
  /^uuid-generator-prr/i,
  /^my-renderer-test$/i,
];

async function fetchHub(includeFixtures) {
  const url = includeFixtures
    ? `${BASE}/api/hub?include_fixtures=true`
    : `${BASE}/api/hub`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`${url}: expected array, got ${typeof body}`);
  return body;
}

let failed = 0;
const assert = (label, ok, detail) => {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
};

console.log(`Hub fixture filter: ${BASE}/api/hub`);

const publicApps = await fetchHub(false);
console.log(`  public /api/hub returned ${publicApps.length} apps`);

const leakedSlugs = publicApps
  .map((a) => a.slug)
  .filter((s) => FIXTURE_PATTERNS.some((re) => re.test(s)));

assert(
  'no fixture slugs in public /api/hub',
  leakedSlugs.length === 0,
  leakedSlugs.length > 0 ? `leaked: ${leakedSlugs.join(', ')}` : '',
);

// Sanity: the hub is not empty (regression against over-aggressive filter).
assert(
  'public /api/hub returns >= 10 real apps',
  publicApps.length >= 10,
  `got ${publicApps.length}`,
);

// Opt-in escape hatch should still return fixtures when they exist in DB.
const allApps = await fetchHub(true);
console.log(`  /api/hub?include_fixtures=true returned ${allApps.length} apps`);

assert(
  'include_fixtures=true returns >= public count',
  allApps.length >= publicApps.length,
  `public=${publicApps.length} all=${allApps.length}`,
);

// Defensive: the opt-in path SHOULD surface fixtures if any are in the DB.
// We don't fail the test if the DB happens to be clean of fixtures —
// that's a valid state post-cleanup — but we log it.
const fixturesSeen = allApps
  .map((a) => a.slug)
  .filter((s) => FIXTURE_PATTERNS.some((re) => re.test(s)));
console.log(
  `  fixtures visible under include_fixtures=true: ${fixturesSeen.length} (${fixturesSeen.slice(0, 5).join(', ')}${fixturesSeen.length > 5 ? ', ...' : ''})`,
);

console.log(failed === 0 ? '\nPASS' : `\nFAIL (${failed} assertions)`);
process.exit(failed === 0 ? 0 : 1);
