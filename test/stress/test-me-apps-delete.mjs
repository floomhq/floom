#!/usr/bin/env node
// DELETE /api/me/apps/:slug — owner-only; non-owner and missing slug are both 404.
//
// Run: node test/stress/test-me-apps-delete.mjs
// Requires: pnpm run build in apps/server

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-me-apps-del-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.PUBLIC_URL = 'http://localhost';

const { db } = await import('../../apps/server/dist/db.js');
const auth = await import('../../apps/server/dist/lib/better-auth.js');
const { meAppsRouter } = await import('../../apps/server/dist/routes/me_apps.js');

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

async function fetchRoute(router, method, path) {
  const req = new Request(`http://localhost${path}`, { method });
  const res = await router.fetch(req);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json, text };
}

function makeManifest(name) {
  return JSON.stringify({
    name,
    description: 'test',
    actions: { run: { label: 'Run', inputs: [], outputs: [] } },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '1.0',
  });
}

function insertApp({ slug, author, workspace_id = 'ws-t' }) {
  const id = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path, workspace_id, author, app_type)
     VALUES (?, ?, ?, ?, ?, 'active', 'proxied:test', ?, ?, 'proxied')`,
  ).run(
    id,
    slug,
    slug,
    't',
    makeManifest(slug),
    workspace_id,
    author,
  );
  return id;
}

auth._resetAuthForTests();
const a = auth.getAuth();
let fakeUser = null;
a.api.getSession = async () => {
  if (!fakeUser) return null;
  return { user: fakeUser, session: { id: 'sess_fake' } };
};

// ---- 1) owner can delete; row is gone
const ownSlug = 'del-owner-' + randomUUID().slice(0, 8);
insertApp({ slug: ownSlug, author: 'user-alice' });
fakeUser = { id: 'user-alice', email: 'alice@example.com', name: 'Alice' };
let r = await fetchRoute(meAppsRouter, 'DELETE', `/${ownSlug}`);
log('owner: 200 and ok: true', r.status === 200 && r.json?.ok === true, String(r.status));
const rowGone = !db
  .prepare('SELECT 1 AS n FROM apps WHERE slug = ?')
  .get(ownSlug);
log('owner: app row removed', rowGone, ownSlug);

// ---- 2) non-owner gets 404 (not 403), same error code as missing
const aliceSlug = 'del-alice-only-' + randomUUID().slice(0, 8);
insertApp({ slug: aliceSlug, author: 'user-alice' });
fakeUser = { id: 'user-bob', email: 'bob@example.com', name: 'Bob' };
r = await fetchRoute(meAppsRouter, 'DELETE', `/${aliceSlug}`);
log('non-owner: 404', r.status === 404, String(r.status));
log(
  'non-owner: not_found code (matches missing slug shape)',
  r.json?.code === 'not_found',
  r.text,
);
const stillThere = db
  .prepare('SELECT 1 AS n FROM apps WHERE slug = ?')
  .get(aliceSlug);
log('non-owner: app not deleted', !!stillThere, aliceSlug);

// ---- 3) missing slug: 404
fakeUser = { id: 'user-alice', email: 'alice@example.com', name: 'Alice' };
r = await fetchRoute(
  meAppsRouter,
  'DELETE',
  '/definitely-missing-slug-zzzzz',
);
log('unknown slug: 404', r.status === 404, String(r.status));
log(
  'unknown slug: same not_found code as non-owner',
  r.json?.code === 'not_found',
  r.text,
);

// ---- 4) cloud anon: 401
fakeUser = null;
const slugAnon = 'del-anon-' + randomUUID().slice(0, 8);
insertApp({ slug: slugAnon, author: 'user-alice' });
r = await fetchRoute(meAppsRouter, 'DELETE', `/${slugAnon}`);
log('unauthenticated: 401', r.status === 401, String(r.status));
const afterAnon = db
  .prepare('SELECT 1 AS n FROM apps WHERE slug = ?')
  .get(slugAnon);
log('unauthenticated: no delete side effect', !!afterAnon, slugAnon);

db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
