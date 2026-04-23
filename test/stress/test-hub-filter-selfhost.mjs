#!/usr/bin/env node
// Hub-filter self-host bypass tests.
//
// Scope: apps/web/src/lib/hub-filter.ts — the SHOWCASE_SLUGS allowlist
// that curates floom.dev's public /apps directory. On a self-hosted
// Floom (server reports cloud_mode: false) that allowlist has to be
// bypassed or the operator sees "0 apps" on a healthy instance — the
// exact regression Federico hit running local Docker (2026-04-22).
//
// Coverage:
//   1. Hosted default (no opts / selfHost: false): allowlist applies,
//      only the three launch-demo slugs pass.
//   2. Self-host (selfHost: true): allowlist bypassed, every non-
//      fixture app passes.
//   3. Test fixtures stay filtered regardless of mode (we never want
//      Swagger Petstore rendering on a user's landing page, hosted or
//      self-host).

import { strict as assert } from 'node:assert';
import {
  isPubliclyListed,
  publicHubApps,
  isTestFixture,
} from '../../apps/web/src/lib/hub-filter.ts';

let passed = 0;
let failed = 0;
function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

const mkApp = (slug, extras = {}) => ({
  slug,
  name: slug,
  description: extras.description || `${slug} app`,
  category: extras.category || null,
  featured: false,
  avg_run_ms: null,
  runs_7d: null,
  ...extras,
});

// Hosted floom.dev baseline.
const demo = mkApp('lead-scorer');
const demo2 = mkApp('competitor-analyzer');
const demo3 = mkApp('resume-screener');
const fastApp = mkApp('uuid');
const ingested = mkApp('stripe-api');
const fixture = mkApp('swagger-petstore', {
  description: 'This is a sample Pet Store Server',
});
const fixture2 = mkApp('my-renderer-test');

console.log('hub-filter: hosted mode (default opts)');

{
  log('launch demo → visible', isPubliclyListed(demo) === true);
  log('launch demo 2 → visible', isPubliclyListed(demo2) === true);
  log('launch demo 3 → visible', isPubliclyListed(demo3) === true);
  log('fast-app hidden on hosted', isPubliclyListed(fastApp) === false);
  log('ingested app hidden on hosted', isPubliclyListed(ingested) === false);
  log('test fixture hidden on hosted', isPubliclyListed(fixture) === false);
  log('test fixture 2 hidden on hosted', isPubliclyListed(fixture2) === false);
}

{
  const visible = publicHubApps(
    [demo, demo2, demo3, fastApp, ingested, fixture, fixture2],
  );
  log(
    'hosted publicHubApps: keeps exactly 3 demos',
    visible.length === 3 &&
      visible.every((a) =>
        ['lead-scorer', 'competitor-analyzer', 'resume-screener'].includes(a.slug),
      ),
    `got ${visible.map((a) => a.slug).join(',')}`,
  );
}

console.log('hub-filter: self-host mode (selfHost: true)');

{
  // Every non-fixture app is surfaced on self-host. This is the main
  // regression — before the bypass, a fresh local-Docker instance showed
  // "0 apps" because only the 3 demo slugs were on the allowlist and
  // those need docker.sock mounted to seed.
  log('launch demo → visible (self-host)',
    isPubliclyListed(demo, { selfHost: true }) === true);
  log('fast-app → visible (self-host)',
    isPubliclyListed(fastApp, { selfHost: true }) === true);
  log('ingested app → visible (self-host)',
    isPubliclyListed(ingested, { selfHost: true }) === true);
  log('test fixture still hidden on self-host',
    isPubliclyListed(fixture, { selfHost: true }) === false);
  log('test fixture 2 still hidden on self-host',
    isPubliclyListed(fixture2, { selfHost: true }) === false);
}

{
  const visible = publicHubApps(
    [demo, demo2, demo3, fastApp, ingested, fixture, fixture2],
    { selfHost: true },
  );
  log(
    'self-host publicHubApps: keeps every non-fixture',
    visible.length === 5 &&
      !visible.some((a) => a.slug === 'swagger-petstore' || a.slug === 'my-renderer-test'),
    `got ${visible.map((a) => a.slug).join(',')}`,
  );
}

console.log('hub-filter: selfHost: false is equivalent to default');

{
  const a = publicHubApps([demo, fastApp, ingested]);
  const b = publicHubApps([demo, fastApp, ingested], { selfHost: false });
  log(
    'omitted selfHost === selfHost:false',
    a.length === b.length && a.every((v, i) => v.slug === b[i].slug),
  );
}

console.log('hub-filter: isTestFixture stays stable');

{
  log('swagger-petstore is fixture', isTestFixture(fixture) === true);
  log('stopwatch-1 is fixture', isTestFixture(mkApp('stopwatch-1')) === true);
  log('my-renderer-test is fixture', isTestFixture(fixture2) === true);
  log('lead-scorer is not fixture', isTestFixture(demo) === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
