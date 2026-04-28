#!/usr/bin/env node
// Launch-blocker audit: FLOOM_STORE_HIDE_SLUGS filters only /api/hub list.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-hub-hide-slugs-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_STORE_HIDE_SLUGS = 'hidden-launch-app, also-hidden ';

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

async function fetchRoute(method, path) {
  const res = await hubRouter.fetch(new Request(`http://localhost${path}`, { method }));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

function insertApp(slug) {
  const manifest = JSON.stringify({
    name: slug,
    description: `${slug} fixture`,
    actions: {
      run: { label: 'Run', inputs: [], outputs: [] },
    },
  });
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path,
        author, workspace_id, app_type, visibility, category, publish_status)
     VALUES (?, ?, ?, ?, ?, 'active', '', 'local', 'local', 'proxied', 'public', 'testing', 'published')`,
  ).run(`app_${randomUUID()}`, slug, slug, `${slug} fixture`, manifest);
}

console.log('Hub FLOOM_STORE_HIDE_SLUGS tests');

insertApp('visible-launch-app');
insertApp('hidden-launch-app');
insertApp('also-hidden');

const listRes = await fetchRoute('GET', '/');
const listSlugs = Array.isArray(listRes.json) ? listRes.json.map((row) => row.slug) : [];
log('GET /api/hub returns 200', listRes.status === 200, `got ${listRes.status}`);
log('visible app remains listed', listSlugs.includes('visible-launch-app'), `got [${listSlugs.join(', ')}]`);
log(
  'FLOOM_STORE_HIDE_SLUGS hides configured slugs from list',
  !listSlugs.includes('hidden-launch-app') && !listSlugs.includes('also-hidden'),
  `got [${listSlugs.join(', ')}]`,
);

const hiddenDetail = await fetchRoute('GET', '/hidden-launch-app');
log('hidden slug direct detail still resolves', hiddenDetail.status === 200, `got ${hiddenDetail.status}`);

db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
