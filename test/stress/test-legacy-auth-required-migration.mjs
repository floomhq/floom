#!/usr/bin/env node
// ADR-008 legacy apps.auth_required migration coverage.

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireFromServer = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const Database = requireFromServer('better-sqlite3');

const tmp = mkdtempSync(join(tmpdir(), 'floom-auth-required-migration-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

let passed = 0;
let failed = 0;
const log = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
};

function manifest(name) {
  return JSON.stringify({
    manifest_version: '2.0',
    name,
    description: `${name} app`,
    actions: {
      run: {
        label: 'Run',
        inputs: [],
        outputs: [{ name: 'ok', label: 'OK', type: 'text' }],
      },
    },
    secrets_needed: [],
  });
}

function seedOldDatabase() {
  mkdirSync(tmp, { recursive: true });
  const old = new Database(join(tmp, 'floom-chat.db'));
  old.exec(`
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      manifest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      docker_image TEXT,
      code_path TEXT NOT NULL,
      category TEXT,
      author TEXT,
      icon TEXT,
      workspace_id TEXT NOT NULL DEFAULT 'local',
      visibility TEXT,
      link_share_token TEXT,
      auth_required BOOLEAN,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const insert = old.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path, category, author, workspace_id,
        visibility, link_share_token, auth_required)
     VALUES (?, ?, ?, ?, ?, 'active', 'proxied:test', NULL, ?, ?, ?, ?, ?)`,
  );
  insert.run('app_legacy_true', 'legacy-true', 'Legacy True', 'legacy', manifest('Legacy True'), 'owner', 'local', 'private', null, 1);
  insert.run('app_legacy_false', 'legacy-false', 'Legacy False', 'legacy', manifest('Legacy False'), 'owner', 'local', 'public', null, 0);
  insert.run('app_legacy_null', 'legacy-null', 'Legacy Null', 'legacy', manifest('Legacy Null'), 'owner', 'local', 'private', null, null);
  insert.run('app_public_true', 'public-true', 'Public True', 'legacy', manifest('Public True'), 'owner', 'local', 'public', null, 1);
  insert.run('app_already', 'already-link', 'Already Link', 'legacy', manifest('Already Link'), 'owner', 'local', 'link', 'ExistingToken123456789012', 0);
  const many = old.transaction(() => {
    for (let i = 0; i < 1500; i++) {
      insert.run(
        `app_many_${i}`,
        `many-${i}`,
        `Many ${i}`,
        'bulk',
        manifest(`Many ${i}`),
        'owner',
        'local',
        'private',
        null,
        1,
      );
    }
  });
  many();
  old.close();
}

console.log('ADR-008 · legacy auth_required migration');
seedOldDatabase();

const warnLines = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  warnLines.push(args.join(' '));
  originalWarn(...args);
};

const { db, migrateLegacyAuthRequiredColumn } = await import('../../apps/server/dist/db.js');
const auth = await import('../../apps/server/dist/lib/better-auth.js');
const { hubRouter } = await import('../../apps/server/dist/routes/hub.js');
const { ingestAppFromSpec } = await import('../../apps/server/dist/services/openapi-ingest.js');

function app(slug) {
  return db.prepare(`SELECT * FROM apps WHERE slug = ?`).get(slug);
}

const cols = db.prepare(`PRAGMA table_info(apps)`).all().map((row) => row.name);
log('auth_required column is dropped', !cols.includes('auth_required'), cols.join(','));
log('link_share_requires_auth column exists', cols.includes('link_share_requires_auth'), cols.join(','));

const migrated = app('legacy-true');
log('auth_required=true migrates to link visibility', migrated.visibility === 'link', migrated.visibility);
log('auth_required=true sets link_share_requires_auth', migrated.link_share_requires_auth === 1, String(migrated.link_share_requires_auth));
log('auth_required=true generates link_share_token', /^[0-9A-Za-z]{24}$/.test(migrated.link_share_token || ''), migrated.link_share_token || '');

const unchangedFalse = app('legacy-false');
log('auth_required=false leaves visibility unchanged', unchangedFalse.visibility === 'public', unchangedFalse.visibility);
log('auth_required=false leaves link auth disabled', unchangedFalse.link_share_requires_auth === 0, String(unchangedFalse.link_share_requires_auth));

const unchangedNull = app('legacy-null');
log('auth_required=NULL leaves row safe', unchangedNull.visibility === 'private' && unchangedNull.link_share_requires_auth === 0, JSON.stringify(unchangedNull));

const impossible = app('public-true');
log('public + auth_required=true is moved private', impossible.visibility === 'private', impossible.visibility);
log('public + auth_required=true is flagged for review', String(impossible.review_comment || '').includes('flagged'), impossible.review_comment || '');
log('impossible state emits migration warning', warnLines.some((line) => line.includes('public-true')), warnLines.join('\n'));

const bulk = db.prepare(`SELECT COUNT(*) AS count FROM apps WHERE slug LIKE 'many-%' AND visibility = 'link' AND link_share_requires_auth = 1 AND link_share_token IS NOT NULL`).get();
log('1500 legacy apps migrate in one boot', bulk.count === 1500, `got ${bulk.count}`);

migrateLegacyAuthRequiredColumn();
const afterNoop = db.prepare(`PRAGMA table_info(apps)`).all().map((row) => row.name);
log('already-migrated DB rerun is a no-op', !afterNoop.includes('auth_required') && app('legacy-true').visibility === 'link');

async function fetchHub(path) {
  const res = await hubRouter.fetch(new Request(`http://localhost${path}`));
  const text = await res.text();
  return { status: res.status, text };
}

auth._resetAuthForTests();
const betterAuth = auth.getAuth();
let fakeUser = null;
betterAuth.api.getSession = async () => {
  if (!fakeUser) return null;
  return { user: fakeUser, session: { id: 'sess_test' } };
};

const correctKey = migrated.link_share_token;
fakeUser = null;
log('link auth app without key and anon returns 401', (await fetchHub('/legacy-true')).status === 401);
log('link auth app with wrong key returns 404', (await fetchHub('/legacy-true?key=wrong')).status === 404);
log('link auth app with correct key and anon returns 401', (await fetchHub(`/legacy-true?key=${correctKey}`)).status === 401);
fakeUser = { id: 'signed-in', email: 'signed@example.com', name: 'Signed In' };
log('signed-in caller with correct link key returns 200', (await fetchHub(`/legacy-true?key=${correctKey}`)).status === 200);

const spec = {
  openapi: '3.0.0',
  info: { title: 'Manifest Link', version: '1.0.0' },
  servers: [{ url: 'https://example.com' }],
  paths: {
    '/ping': {
      get: {
        operationId: 'ping',
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

await ingestAppFromSpec({
  spec,
  slug: 'manifest-link',
  workspace_id: 'local',
  author_user_id: 'owner',
  link_share_requires_auth: true,
});
const manifestLink = app('manifest-link');
log('new manifest link_share_requires_auth publishes as link', manifestLink.visibility === 'link');
log('new manifest link_share_requires_auth persists flag', manifestLink.link_share_requires_auth === 1);
log('new manifest link_share_requires_auth creates token', /^[0-9A-Za-z]{24}$/.test(manifestLink.link_share_token || ''), manifestLink.link_share_token || '');

const warningsBeforeLegacy = warnLines.length;
await ingestAppFromSpec({
  spec,
  slug: 'manifest-legacy',
  workspace_id: 'local',
  author_user_id: 'owner',
  auth_required: true,
});
const legacyManifest = app('manifest-legacy');
log('legacy manifest auth_required still publishes', legacyManifest.visibility === 'link' && legacyManifest.link_share_requires_auth === 1);
log('legacy manifest auth_required emits deprecation warning', warnLines.length > warningsBeforeLegacy && warnLines.some((line) => line.includes('manifest-legacy')));

let bothRejected = false;
let bothMessage = '';
try {
  await ingestAppFromSpec({
    spec,
    slug: 'manifest-both',
    workspace_id: 'local',
    author_user_id: 'owner',
    auth_required: true,
    link_share_requires_auth: true,
  });
} catch (err) {
  bothRejected = true;
  bothMessage = err.message || String(err);
}
log('manifest with both auth fields is rejected', bothRejected);
log('manifest with both auth fields has clear error', bothMessage.includes('use link_share_requires_auth, not both fields'), bothMessage);

console.warn = originalWarn;
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
