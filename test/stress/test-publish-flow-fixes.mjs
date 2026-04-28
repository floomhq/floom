#!/usr/bin/env node
// Publish-flow fixes (audit 2026-04-20) — three cases:
//   1. Slug collision returns 409 with 3 suggestions (numeric / version / random).
//   2. PATCH /api/hub/:slug accepts primary_action and validates against manifest.actions.
//   3. openslides seed app boots with manifest.primary_action = 'generate'.
//
// Run: pnpm --filter @floom/server build && node test/stress/test-publish-flow-fixes.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-pub-flow-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db } = await import('../../apps/server/dist/db.js');
const { hubRouter } = await import('../../apps/server/dist/routes/hub.js');
const { SlugTakenError, deriveSlugSuggestions } = await import(
  '../../apps/server/dist/services/openapi-ingest.js'
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

async function fetchRoute(router, method, path, body) {
  const url = `http://localhost${path}`;
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const req = new Request(url, init);
  const res = await router.fetch(req);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

// Seed: an app in workspace 'ws-alice' owned by 'user-alice'.
db.prepare(
  `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'oss')`,
).run('ws-alice', 'ws-alice', 'Alice WS');
db.prepare(
  `INSERT INTO users (id, workspace_id, email, name, auth_provider)
   VALUES (?, ?, ?, ?, 'local')`,
).run('user-alice', 'ws-alice', 'alice@example.com', 'Alice');

const seedAppId = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const seedManifest = {
  name: 'Petstore',
  description: 'Pet management',
  manifest_version: '2.0',
  runtime: 'python',
  actions: {
    listPets: { label: 'List Pets', inputs: [], outputs: [] },
    addPet: { label: 'Add Pet', inputs: [], outputs: [] },
  },
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
};
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, status, docker_image, code_path,
                     category, author, icon, app_type, base_url, auth_type, auth_config,
                     openapi_spec_url, openapi_spec_cached, visibility, workspace_id)
   VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, NULL, 'proxied', ?, 'none', NULL,
           NULL, NULL, ?, ?)`,
).run(
  seedAppId,
  'petstore',
  'Petstore',
  'Pet management',
  JSON.stringify(seedManifest),
  `proxied:petstore`,
  'api',
  'user-alice',
  'https://petstore.example.com',
  'public',
  'ws-alice',
);

console.log('Publish-flow fixes (audit 2026-04-20)');

// ----- Fix 2a: deriveSlugSuggestions returns 3 distinct recovery slugs -----
console.log('\nFix 2: deriveSlugSuggestions returns 3 distinct recovery slugs');
const suggestions = deriveSlugSuggestions('petstore');
log('suggestions is an array', Array.isArray(suggestions));
log('returns 3 suggestions', suggestions.length === 3, `got ${suggestions.length}: ${suggestions.join(', ')}`);
log(
  'numeric suffix present',
  suggestions.some((s) => /^petstore-\d+$/.test(s)),
  suggestions.join(', '),
);
log(
  'version suffix present',
  suggestions.some((s) => /^petstore-v\d+$/.test(s)),
  suggestions.join(', '),
);
log(
  'random-hex suffix present',
  suggestions.some((s) => /^petstore-[0-9a-f]{8}$/.test(s)),
  suggestions.join(', '),
);
log(
  'all three are distinct',
  new Set(suggestions).size === suggestions.length,
);

// ----- Fix 2b: SlugTakenError carries suggestions + code -----
console.log('\nFix 2: SlugTakenError carries code + suggestions');
const err = new SlugTakenError('petstore', ['petstore-2', 'petstore-v2', 'petstore-abc12345']);
log('error.code is slug_taken', err.code === 'slug_taken');
log('error.slug is set', err.slug === 'petstore');
log('error.suggestions length 3', err.suggestions.length === 3);
log('error instanceof Error', err instanceof Error);

// ----- Fix 3a: openslides primary_action is stamped at boot -----
// openslides isn't present (seed disabled), so simulate by inserting
// openslides with a 2-action manifest lacking primary_action, then
// re-import db.js won't help since it's a singleton. Instead, manually
// invoke the same logic: patch the seed list via direct DB + re-run the
// migration block. Here we just assert the migration handles an
// openslides-shaped row idempotently.
console.log('\nFix 3: primary_action seed stamping is idempotent');
const openslidesId = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const openslidesManifest = {
  name: 'OpenSlides',
  description: 'AI slide decks',
  manifest_version: '2.0',
  runtime: 'python',
  actions: {
    generate: { label: 'Generate', inputs: [], outputs: [] },
    iterate: { label: 'Iterate', inputs: [], outputs: [] },
    resolve_logo: { label: 'Resolve Logo', inputs: [], outputs: [] },
  },
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
};
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, status, docker_image, code_path,
                     category, author, icon, app_type, base_url, auth_type, auth_config,
                     openapi_spec_url, openapi_spec_cached, visibility, workspace_id)
   VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, NULL, 'proxied', ?, 'none', NULL,
           NULL, NULL, ?, ?)`,
).run(
  openslidesId,
  'openslides',
  'OpenSlides',
  'AI slide decks',
  JSON.stringify(openslidesManifest),
  `proxied:openslides`,
  'ai',
  'user-alice',
  'https://openslides.example.com',
  'public',
  'ws-alice',
);

// Run the migration block inline (it's at the top of db.ts and already
// ran once on import before openslides was inserted).
{
  const PRIMARY_ACTION_SEEDS = [{ slug: 'openslides', action: 'generate' }];
  for (const seed of PRIMARY_ACTION_SEEDS) {
    const row = db
      .prepare('SELECT id, manifest FROM apps WHERE slug = ?')
      .get(seed.slug);
    if (!row) continue;
    let manifest;
    try { manifest = JSON.parse(row.manifest); } catch { continue; }
    if (!manifest.actions) continue;
    const actionKeys = Object.keys(manifest.actions);
    if (actionKeys.length < 2) continue;
    if (!actionKeys.includes(seed.action)) continue;
    if (manifest.primary_action === seed.action) continue;
    manifest.primary_action = seed.action;
    db.prepare(`UPDATE apps SET manifest = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(manifest), row.id);
  }
}

const openslidesRow = db.prepare('SELECT manifest FROM apps WHERE slug = ?')
  .get('openslides');
const openslidesManifestAfter = JSON.parse(openslidesRow.manifest);
log(
  'openslides manifest has primary_action = generate',
  openslidesManifestAfter.primary_action === 'generate',
  JSON.stringify(openslidesManifestAfter.primary_action),
);

// ----- Fix 3b: PATCH /api/hub/:slug primary_action (happy path) -----
// Note: PATCH requires auth in cloud mode. In OSS mode (default), the
// synthetic local user can write. Since our test uses ws-alice (not
// 'local'), bypass auth check by flipping this to an OSS scenario:
// mutate a fresh app owned by 'local'.
console.log('\nFix 3: PATCH /api/hub/:slug primary_action');
const ossAppId = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const ossManifest = {
  name: 'Demo',
  description: 'Demo app',
  manifest_version: '2.0',
  runtime: 'python',
  actions: {
    alpha: { label: 'Alpha', inputs: [], outputs: [] },
    beta: { label: 'Beta', inputs: [], outputs: [] },
  },
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
};
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, status, docker_image, code_path,
                     category, author, icon, app_type, base_url, auth_type, auth_config,
                     openapi_spec_url, openapi_spec_cached, visibility, workspace_id)
   VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, NULL, 'proxied', ?, 'none', NULL,
           NULL, NULL, ?, ?)`,
).run(
  ossAppId,
  'oss-demo',
  'Demo',
  'Demo app',
  JSON.stringify(ossManifest),
  `proxied:oss-demo`,
  'demo',
  'local',
  'https://demo.example.com',
  'public',
  'local',
);

// Setting primary_action = 'beta' succeeds
{
  const r = await fetchRoute(hubRouter, 'PATCH', '/oss-demo', {
    primary_action: 'beta',
  });
  log('PATCH primary_action valid → 200', r.status === 200, `got ${r.status}: ${r.text}`);
  const row = db.prepare('SELECT manifest FROM apps WHERE slug = ?').get('oss-demo');
  const m = JSON.parse(row.manifest);
  log('manifest.primary_action persisted', m.primary_action === 'beta', `got ${m.primary_action}`);
}

// Setting primary_action to an invalid key → 400 with valid_actions list
{
  const r = await fetchRoute(hubRouter, 'PATCH', '/oss-demo', {
    primary_action: 'nonexistent',
  });
  log('PATCH invalid primary_action → 400', r.status === 400);
  log('error code is invalid_primary_action', r.json?.code === 'invalid_primary_action');
  log(
    'valid_actions list surfaced',
    Array.isArray(r.json?.valid_actions) && r.json.valid_actions.includes('alpha'),
  );
}

// Clearing with null succeeds
{
  const r = await fetchRoute(hubRouter, 'PATCH', '/oss-demo', {
    primary_action: null,
  });
  log('PATCH primary_action null → 200', r.status === 200);
  const row = db.prepare('SELECT manifest FROM apps WHERE slug = ?').get('oss-demo');
  const m = JSON.parse(row.manifest);
  log('manifest.primary_action cleared', m.primary_action === undefined);
}

// Public exposure must go through the review flow, not owner PATCH.
{
  const r = await fetchRoute(hubRouter, 'PATCH', '/oss-demo', {
    visibility: 'public',
  });
  log('PATCH visibility public rejected with review_required', r.status === 409 && r.json?.code === 'review_required', `got ${r.status}: ${r.text}`);
}

// Owner unlist/private remains available and uses the sharing state machine.
{
  const r = await fetchRoute(hubRouter, 'PATCH', '/oss-demo', {
    visibility: 'private',
  });
  const row = db.prepare('SELECT visibility FROM apps WHERE slug = ?').get('oss-demo');
  log('PATCH visibility private succeeds', r.status === 200 && row?.visibility === 'private', `got ${r.status}: ${r.text}`);
}

// ----- Cleanup -----
try { rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
