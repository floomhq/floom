#!/usr/bin/env node
// Adapter migration regression test for seed.ts + launch-demos.ts.
//
// Background: these two services used to run hand-written
// `INSERT ... ON CONFLICT` / `UPDATE apps WHERE id = ?` SQL directly.
// They now route through `adapters.storage.createApp` + `.updateApp`
// instead. This test exercises the adapter methods with inputs shaped
// like what those two services pass and asserts the resulting DB row
// matches what the prior raw SQL would have written.
//
// Uses a throwaway DATA_DIR so it never pollutes the real server DB.
// Run: tsx test/stress/test-adapters-seed-launchdemos.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-adapters-migration-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db } = await import('../../apps/server/src/db.ts');
const { adapters } = await import(
  '../../apps/server/src/adapters/index.ts'
);

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

console.log('adapters migration: seed.ts + launch-demos.ts');

// ---- seed.ts path: createApp inserts with publish_status='published' ----
adapters.storage.createApp({
  id: 'app_seed_1',
  slug: 'seed-demo',
  name: 'Seed Demo',
  description: 'first-party seed',
  manifest: JSON.stringify({ name: 'Seed Demo' }),
  status: 'active',
  docker_image: 'floom-seed:v1',
  code_path: 'reused:marketplace_seed',
  category: 'demo',
  author: 'floom',
  icon: null,
  publish_status: 'published',
});
const seeded = db.prepare('SELECT * FROM apps WHERE slug = ?').get('seed-demo');
log('seed.ts createApp: row inserted', seeded?.id === 'app_seed_1');
log('seed.ts createApp: status=active', seeded?.status === 'active');
log(
  'seed.ts createApp: publish_status=published',
  seeded?.publish_status === 'published',
);

// ---- seed.ts path: updateApp refreshes seed-owned columns, leaves others ----
db.prepare(
  'UPDATE apps SET stars = 7, featured = 1 WHERE slug = ?',
).run('seed-demo');
adapters.storage.updateApp('seed-demo', {
  name: 'Seed Demo v2',
  description: 'refreshed',
  manifest: JSON.stringify({ name: 'Seed Demo v2' }),
  status: 'active',
  docker_image: 'floom-seed:v2',
  code_path: 'reused:marketplace_seed',
  category: 'demo',
  author: 'floom',
  icon: null,
});
const refreshed = db.prepare('SELECT * FROM apps WHERE slug = ?').get('seed-demo');
log('seed.ts updateApp: name refreshed', refreshed?.name === 'Seed Demo v2');
log(
  'seed.ts updateApp: docker_image refreshed',
  refreshed?.docker_image === 'floom-seed:v2',
);
log('seed.ts updateApp: stars preserved', refreshed?.stars === 7);
log('seed.ts updateApp: featured preserved', refreshed?.featured === 1);
log(
  'seed.ts updateApp: publish_status preserved',
  refreshed?.publish_status === 'published',
);

// ---- launch-demos.ts path: createApp with hero=1 + publish_status='published' ----
adapters.storage.createApp({
  id: 'app_demo_1',
  slug: 'lead-scorer',
  name: 'Lead Scorer',
  description: 'launch showcase',
  manifest: JSON.stringify({ name: 'Lead Scorer' }),
  status: 'active',
  docker_image: 'floom-demo-lead-scorer:ctx-deadbeefdeadbeef',
  code_path: 'reused:launch-demo:lead-scorer:ctx-deadbeefdeadbeef',
  category: 'ai',
  author: 'floom',
  icon: null,
  publish_status: 'published',
  hero: 1,
});
const launchRow = db.prepare('SELECT * FROM apps WHERE slug = ?').get('lead-scorer');
log('launch-demos createApp: row inserted', launchRow?.id === 'app_demo_1');
log('launch-demos createApp: hero=1', launchRow?.hero === 1);
log(
  'launch-demos createApp: publish_status=published',
  launchRow?.publish_status === 'published',
);

// ---- launch-demos.ts path: updateApp refreshes + still sets hero=1 ----
adapters.storage.updateApp('lead-scorer', {
  name: 'Lead Scorer v2',
  description: 'refreshed',
  manifest: JSON.stringify({ name: 'Lead Scorer v2' }),
  status: 'active',
  docker_image: 'floom-demo-lead-scorer:ctx-cafef00dcafef00d',
  code_path: 'reused:launch-demo:lead-scorer:ctx-cafef00dcafef00d',
  category: 'ai',
  author: 'floom',
  icon: null,
  hero: 1,
});
const launchUpdated = db
  .prepare('SELECT * FROM apps WHERE slug = ?')
  .get('lead-scorer');
log(
  'launch-demos updateApp: name refreshed',
  launchUpdated?.name === 'Lead Scorer v2',
);
log(
  'launch-demos updateApp: docker_image refreshed',
  launchUpdated?.docker_image === 'floom-demo-lead-scorer:ctx-cafef00dcafef00d',
);
log('launch-demos updateApp: hero=1 preserved', launchUpdated?.hero === 1);

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
