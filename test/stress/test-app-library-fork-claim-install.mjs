#!/usr/bin/env node
// App library primitives: fork, claim, install.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-app-library-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_SEED_APPS = 'false';
process.env.FLOOM_SEED_LAUNCH_DEMOS = 'false';

const { db } = await import('../../apps/server/dist/db.js');
const library = await import('../../apps/server/dist/services/app_library.js');
const sharing = await import('../../apps/server/dist/services/sharing.js');

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

const ctx = {
  workspace_id: 'local',
  user_id: 'local',
  device_id: 'test-device',
  is_authenticated: true,
};

const manifest = {
  name: 'Library Fixture',
  description: 'Fixture',
  manifest_version: '2.0',
  runtime: 'python',
  actions: { run: { label: 'Run', inputs: [], outputs: [] } },
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: ['API_KEY'],
};

function insertApp({ id, slug, author = 'alice', workspace = 'ws_alice', visibility = 'public_live', publish = 'published' }) {
  db.prepare(
    `INSERT INTO apps (
       id, slug, name, description, manifest, status, code_path,
       author, workspace_id, visibility, publish_status, link_share_token
     ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    slug,
    slug,
    'Fixture',
    JSON.stringify(manifest),
    `proxied:${slug}`,
    author,
    workspace,
    visibility,
    publish,
    visibility === 'link' ? 'share_key' : null,
  );
}

console.log('App library fork/claim/install');

try {
  insertApp({ id: 'app_source', slug: 'source-app' });
  db.prepare(`INSERT INTO app_secret_policies (app_id, key, policy) VALUES ('app_source', 'API_KEY', 'creator_override')`).run();
  db.prepare(`INSERT INTO runs (id, app_id, action, status, workspace_id, user_id, device_id) VALUES ('run_source', 'app_source', 'run', 'succeeded', 'ws_alice', 'alice', 'dev')`).run();

  const forked = library.forkApp(ctx, 'source-app', { slug: 'source-copy', name: 'Source Copy' });
  const forkRow = db.prepare(`SELECT * FROM apps WHERE slug = 'source-copy'`).get();
  log('fork creates requested private slug', forked.app.slug === 'source-copy' && forkRow?.visibility === 'private', JSON.stringify(forkRow));
  log('fork records source lineage', forkRow?.forked_from_app_id === 'app_source', JSON.stringify(forkRow));
  log('fork does not copy link token', forkRow?.link_share_token === null, JSON.stringify(forkRow));
  log('fork does not copy runs', db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE app_id = ?`).get(forkRow.id).n === 0);
  log('fork does not copy secret policies', db.prepare(`SELECT COUNT(*) AS n FROM app_secret_policies WHERE app_id = ?`).get(forkRow.id).n === 0);

  insertApp({ id: 'app_unowned', slug: 'unowned-app', author: null, workspace: 'local', visibility: 'public', publish: 'published' });
  const claimed = library.claimApp(ctx, 'unowned-app');
  log('claim moves local unowned app into caller workspace', claimed.app.author === 'local' && claimed.app.workspace_id === 'local' && claimed.app.visibility === 'private', JSON.stringify(claimed.app));
  log('claim stamps claimed_at', typeof claimed.app.claimed_at === 'string' && claimed.app.claimed_at.length > 0, JSON.stringify(claimed.app));
  let secondClaimCode = null;
  try {
    library.claimApp(ctx, 'unowned-app');
  } catch (err) {
    secondClaimCode = err.code;
  }
  log('claim rejects already claimed rows', secondClaimCode === 'already_owned', String(secondClaimCode));

  const firstInstall = library.installApp(ctx, 'source-app');
  const secondInstall = library.installApp(ctx, 'source-app');
  log('install creates a pin once', firstInstall.installed === true && secondInstall.installed === false);
  log('install list includes source app', library.listInstalledApps(ctx).some((app) => app.slug === 'source-app'));
  log('install does not grant owner rights', sharing.isAppOwner(firstInstall.app, ctx) === false);
  const uninstalled = library.uninstallApp(ctx, 'source-app');
  log('uninstall removes the pin', uninstalled.removed === true && library.listInstalledApps(ctx).length === 0);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
