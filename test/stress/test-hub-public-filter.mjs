#!/usr/bin/env node
// Public directory feed: hide QA/demo fixtures server-side while keeping
// direct permalinks reachable.
//
// Run: node test/stress/test-hub-public-filter.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-hub-public-filter-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';

const { db } = await import('../../apps/server/dist/db.js');
const { hubRouter } = await import('../../apps/server/dist/routes/hub.js');

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

console.log('Hub public directory filter');

async function fetchRoute(method, path) {
  const res = await hubRouter.fetch(new Request(`http://localhost${path}`, { method }));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json, text };
}

function insertApp({ slug, description, category = 'utilities' }) {
  const id = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const manifest = JSON.stringify({
    name: slug,
    description,
    actions: {
      run: { description: 'run it', input_schema: {}, output_schema: {} },
    },
  });
  // Fixtures represent already-reviewed/live apps, so publish_status='published'
  // matches the migration backfill (#362). Without it, the publish-review gate
  // in GET /api/hub would hide these rows from the public directory.
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path,
        author, workspace_id, app_type, visibility, category, publish_status)
     VALUES (?, ?, ?, ?, ?, 'active', 'proxied:test', 'local', 'local', 'proxied', 'public', ?, 'published')`,
  ).run(id, slug, slug, description, manifest, category);
}

insertApp({ slug: 'uuid', description: 'UUID generator' });
insertApp({ slug: 'swagger-petstore', description: 'Fixture Petstore app' });
insertApp({ slug: 'my-renderer-test', description: 'Renderer smoke app' });
insertApp({ slug: 'demo-httpbin', description: 'A simple HTTP Request & Response Service' });

const listRes = await fetchRoute('GET', '/');
log('GET /api/hub returns 200', listRes.status === 200, `got ${listRes.status}`);
const listSlugs = Array.isArray(listRes.json) ? listRes.json.map((row) => row.slug) : [];
log('public app stays listed', listSlugs.includes('uuid'), `got [${listSlugs.join(', ')}]`);
log(
  'fixture slug is hidden from /api/hub',
  !listSlugs.includes('swagger-petstore') && !listSlugs.includes('my-renderer-test'),
  `got [${listSlugs.join(', ')}]`,
);
log(
  'fixture description is hidden from /api/hub',
  !listSlugs.includes('demo-httpbin'),
  `got [${listSlugs.join(', ')}]`,
);

const petstoreRes = await fetchRoute('GET', '/swagger-petstore');
log('direct permalink for hidden fixture still works', petstoreRes.status === 200, `got ${petstoreRes.status}`);

const httpbinRes = await fetchRoute('GET', '/demo-httpbin');
log(
  'description-hidden fixture still resolves by slug',
  httpbinRes.status === 200,
  `got ${httpbinRes.status}`,
);

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
