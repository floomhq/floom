#!/usr/bin/env node
// Private-visibility boundary tests.
//
// Verifies that apps with visibility='private' are:
//   1. Never listed by GET /api/hub (public directory)
//   2. Never matched by MCP search_apps / embeddings.pickApps
//   3. Reachable via GET /api/hub/:slug only for the author (404 otherwise)
//   4. Reachable via GET /api/hub/mine for the author
//   5. Non-author callers see 404 (not 403) so the slug's existence
//      is not leaked
//
// Companion to test-w31-auth-boundary.mjs — covers the one surface that
// boundary test does not: visibility='private' on the apps table.
//
// Run: node test/stress/test-visibility-private.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-vis-private-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

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

console.log('Visibility · private-app boundary');

async function fetchRoute(router, method, path, body, cookie) {
  const url = `http://localhost${path}`;
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  if (cookie) {
    init.headers = { ...(init.headers || {}), cookie };
  }
  const req = new Request(url, init);
  const res = await router.fetch(req);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json, text };
}

// ---- seed apps: public + private + auth-required ----
// Fixtures represent already-reviewed/live apps, so publish_status='published'
// matches the migration backfill (#362). Without it, the publish-review gate
// in GET /api/hub would hide these rows and break the visibility assertions.
function insertApp({ slug, visibility, author }) {
  const id = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const manifest = JSON.stringify({
    name: slug,
    description: `${slug} app`,
    actions: {
      run: { description: 'run it', input_schema: {}, output_schema: {} },
    },
  });
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path,
        author, workspace_id, app_type, visibility, publish_status)
     VALUES (?, ?, ?, ?, ?, 'active', 'proxied:test', ?, 'local', 'proxied', ?, 'published')`,
  ).run(id, slug, slug, `${slug} app`, manifest, author, visibility);
  return id;
}

insertApp({ slug: 'pub-one', visibility: 'public', author: 'alice' });
insertApp({ slug: 'pub-two', visibility: 'public', author: 'bob' });
insertApp({ slug: 'priv-alice', visibility: 'private', author: 'alice' });
insertApp({ slug: 'priv-bob', visibility: 'private', author: 'bob' });
insertApp({ slug: 'gated', visibility: 'auth-required', author: 'alice' });

// ---- 1. GET /api/hub/ excludes private apps ----
const listRes = await fetchRoute(hubRouter, 'GET', '/');
log(
  'GET /api/hub/: returns 200',
  listRes.status === 200,
  `got ${listRes.status}`,
);
const listedSlugs = Array.isArray(listRes.json)
  ? listRes.json.map((a) => a.slug)
  : [];
log(
  'GET /api/hub/: lists public apps',
  listedSlugs.includes('pub-one') && listedSlugs.includes('pub-two'),
  `got [${listedSlugs.join(', ')}]`,
);
log(
  'GET /api/hub/: hides priv-alice',
  !listedSlugs.includes('priv-alice'),
  `leaked! got [${listedSlugs.join(', ')}]`,
);
log(
  'GET /api/hub/: hides priv-bob',
  !listedSlugs.includes('priv-bob'),
  `leaked! got [${listedSlugs.join(', ')}]`,
);

// ---- 2. embeddings.pickApps excludes private ----
const { pickApps } = await import(
  '../../apps/server/dist/services/embeddings.js'
);
const matches = await pickApps('test app', 10);
const matchSlugs = matches.map((m) => m.slug);
log(
  'pickApps: never returns private apps',
  !matchSlugs.includes('priv-alice') && !matchSlugs.includes('priv-bob'),
  `leaked! got [${matchSlugs.join(', ')}]`,
);

// ---- 3. GET /api/hub/:slug returns 404 for private to non-author ----
// In OSS mode the synthetic local user is 'local' (DEFAULT_USER_ID), which
// does NOT match 'alice' or 'bob' author values — so both private apps are
// invisible to the test runner, which is what we want.
const privAliceAnon = await fetchRoute(hubRouter, 'GET', '/priv-alice');
log(
  'GET /api/hub/priv-alice (anon): 404 (not 403)',
  privAliceAnon.status === 404,
  `got ${privAliceAnon.status}`,
);

// Public apps stay reachable.
const pubOneAnon = await fetchRoute(hubRouter, 'GET', '/pub-one');
log(
  'GET /api/hub/pub-one (anon): 200',
  pubOneAnon.status === 200,
  `got ${pubOneAnon.status}`,
);

// ---- 4. author sees their own private app via /mine ----
// Seed a local-author private app so the OSS default user context finds it.
insertApp({ slug: 'priv-local', visibility: 'private', author: 'local' });

const mineRes = await fetchRoute(hubRouter, 'GET', '/mine');
log(
  'GET /api/hub/mine: returns 200',
  mineRes.status === 200,
  `got ${mineRes.status}`,
);
const mineSlugs = mineRes.json?.apps?.map((a) => a.slug) ?? [];
log(
  'GET /api/hub/mine: includes owner private app',
  mineSlugs.includes('priv-local'),
  `got [${mineSlugs.join(', ')}]`,
);

// ---- 5. author can GET their own private app directly ----
const privLocalOwner = await fetchRoute(hubRouter, 'GET', '/priv-local');
log(
  'GET /api/hub/priv-local (owner): 200',
  privLocalOwner.status === 200,
  `got ${privLocalOwner.status}`,
);

// ---- 6. category filter on list still hides private ----
db.prepare("UPDATE apps SET category = 'research' WHERE slug = 'priv-alice'").run();
db.prepare("UPDATE apps SET category = 'research' WHERE slug = 'pub-one'").run();
const filtered = await fetchRoute(hubRouter, 'GET', '/?category=research');
const filteredSlugs = Array.isArray(filtered.json)
  ? filtered.json.map((a) => a.slug)
  : [];
log(
  'GET /api/hub/?category=research: includes public match',
  filteredSlugs.includes('pub-one'),
  `got [${filteredSlugs.join(', ')}]`,
);
log(
  'GET /api/hub/?category=research: still hides private',
  !filteredSlugs.includes('priv-alice'),
  `leaked! got [${filteredSlugs.join(', ')}]`,
);

// ---- cleanup ----
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
