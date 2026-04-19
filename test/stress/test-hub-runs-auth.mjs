#!/usr/bin/env node
// Security regression test for issue #124: GET /api/hub/:slug/runs leaked
// every user's run inputs + outputs to unauthenticated callers in Cloud
// mode because the OSS escape hatch (workspace_id='local' &&
// app.workspace_id='local') matched the synthetic anon context.
//
// Asserts:
//   1. Cloud mode · anon caller → 401 Unauthorized (no body leak)
//   2. Cloud mode · authed caller A sees only their own runs
//      (every returned row has is_self=true)
//   3. Cloud mode · authed caller A does NOT see caller B's runs
//   4. OSS mode · synthetic local caller still sees runs on local apps
//      (back-compat for self-host single-user case)
//
// Run: node test/stress/test-hub-runs-auth.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-hub-runs-auth-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db } = await import('../../apps/server/dist/db.js');
const auth = await import('../../apps/server/dist/lib/better-auth.js');
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

console.log('Hub · /:slug/runs auth (regression for #124)');

// ---- helpers ----
async function fetchRoute(router, method, path, headers = {}) {
  const url = `http://localhost${path}`;
  const req = new Request(url, { method, headers });
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

function seedUser(id, email, name) {
  db.prepare(
    `INSERT INTO users (id, email, name, auth_provider, auth_subject)
     VALUES (?, ?, ?, 'better-auth', ?)`,
  ).run(id, email, name, id);
}

function seedWorkspace(id, slug, user_id) {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'cloud_free')`,
  ).run(id, slug, `${slug} ws`);
  db.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'admin')`,
  ).run(id, user_id);
  db.prepare(
    `INSERT INTO user_active_workspace (user_id, workspace_id, updated_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(user_id, id);
}

function insertApp({ slug, workspace_id, author }) {
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
        author, workspace_id, app_type, visibility)
     VALUES (?, ?, ?, ?, ?, 'active', 'proxied:test', ?, ?, 'proxied', 'public')`,
  ).run(id, slug, slug, `${slug} app`, manifest, author, workspace_id);
  return id;
}

function insertRun({ app_id, workspace_id, user_id, device_id, inputs, outputs }) {
  const id = `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  db.prepare(
    `INSERT INTO runs (id, app_id, action, status, inputs, outputs,
                       duration_ms, started_at, workspace_id, user_id, device_id)
     VALUES (?, ?, 'run', 'success', ?, ?, 5, datetime('now'), ?, ?, ?)`,
  ).run(
    id,
    app_id,
    JSON.stringify(inputs),
    JSON.stringify(outputs),
    workspace_id,
    user_id,
    device_id,
  );
  return id;
}

// ---- seed users, workspaces, an app, runs from both users ----
seedUser('user-alice', 'alice@example.com', 'Alice');
seedUser('user-bob', 'bob@example.com', 'Bob');
seedWorkspace('ws-alice', 'alice-ws', 'user-alice');
seedWorkspace('ws-bob', 'bob-ws', 'user-bob');

// App owned by Alice.
const appId = insertApp({
  slug: 'leaky-app',
  workspace_id: 'ws-alice',
  author: 'user-alice',
});

// Alice ran it (sensitive password-like output).
insertRun({
  app_id: appId,
  workspace_id: 'ws-alice',
  user_id: 'user-alice',
  device_id: 'dev-alice',
  inputs: { length: 16 },
  outputs: { password: 'ALICE-SECRET-abc123' },
});

// Bob ran it too.
insertRun({
  app_id: appId,
  workspace_id: 'ws-bob',
  user_id: 'user-bob',
  device_id: 'dev-bob',
  inputs: { length: 8 },
  outputs: { password: 'BOB-SECRET-xyz789' },
});

// Anonymous device caller also ran it.
insertRun({
  app_id: appId,
  workspace_id: 'local',
  user_id: null,
  device_id: 'dev-anon-1',
  inputs: { length: 4 },
  outputs: { password: 'ANON-SECRET-q1w2' },
});

// Also seed a 'local'/'local' app so we can exercise the OSS branch later.
const localAppId = insertApp({
  slug: 'seed-local',
  workspace_id: 'local',
  author: 'local',
});
insertRun({
  app_id: localAppId,
  workspace_id: 'local',
  user_id: null,
  device_id: 'dev-ossbox',
  inputs: { n: 1 },
  outputs: { greeting: 'hi' },
});

// ---- inject Better Auth sessions ----
auth._resetAuthForTests();
const a = auth.getAuth();
let fakeUser = null;
a.api.getSession = async () => {
  if (!fakeUser) return null;
  return { user: fakeUser, session: { id: 'sess_fake' } };
};

// =====================================================================
// 1. Cloud mode · anon → 401
// =====================================================================
console.log('\n[1] Cloud mode anon caller → 401');
fakeUser = null;
let r = await fetchRoute(hubRouter, 'GET', '/leaky-app/runs');
log('anon caller: 401 Unauthorized', r.status === 401, `got ${r.status}`);
log(
  'anon caller: response does NOT leak inputs/outputs',
  r.text.indexOf('ALICE-SECRET') === -1 &&
    r.text.indexOf('BOB-SECRET') === -1 &&
    r.text.indexOf('ANON-SECRET') === -1,
  'leaked content in 401 body',
);

// =====================================================================
// 2. Cloud mode · Alice sees only her runs (all is_self=true)
// =====================================================================
console.log('\n[2] Authed Alice sees only her own runs');
fakeUser = { id: 'user-alice', email: 'alice@example.com', name: 'Alice' };
r = await fetchRoute(hubRouter, 'GET', '/leaky-app/runs');
log('Alice: 200 OK', r.status === 200, `got ${r.status}`);
log(
  'Alice: response includes her password',
  r.text.indexOf('ALICE-SECRET-abc123') !== -1,
);
log(
  'Alice: response does NOT include Bob\'s password',
  r.text.indexOf('BOB-SECRET-xyz789') === -1,
);
log(
  'Alice: response does NOT include anon device caller\'s output',
  r.text.indexOf('ANON-SECRET-q1w2') === -1,
);
const aliceRuns = r.json?.runs || [];
log(
  'Alice: every returned run has is_self=true',
  aliceRuns.length > 0 && aliceRuns.every((run) => run.is_self === true),
  `runs=${JSON.stringify(aliceRuns.map((x) => ({ id: x.id, is_self: x.is_self })))}`,
);
log(
  'Alice: run count matches her owned runs (1)',
  aliceRuns.length === 1,
  `got ${aliceRuns.length}`,
);

// =====================================================================
// 3. Cloud mode · Bob is NOT the owner → 403 not_owner
// =====================================================================
console.log('\n[3] Authed non-owner Bob → 403 not_owner');
fakeUser = { id: 'user-bob', email: 'bob@example.com', name: 'Bob' };
r = await fetchRoute(hubRouter, 'GET', '/leaky-app/runs');
log('Bob: 403 Forbidden', r.status === 403, `got ${r.status}`);
log('Bob: error code is not_owner', r.json?.code === 'not_owner');
log(
  'Bob: response does NOT leak Alice\'s output',
  r.text.indexOf('ALICE-SECRET-abc123') === -1,
);

// =====================================================================
// 4. Cloud mode · anon cannot fish local-seeded app either
// =====================================================================
console.log('\n[4] Cloud mode anon cannot fish local-authored app');
fakeUser = null;
r = await fetchRoute(hubRouter, 'GET', '/seed-local/runs');
log('anon on /seed-local/runs: 401', r.status === 401, `got ${r.status}`);
log(
  'anon on /seed-local/runs: no leak',
  r.text.indexOf('greeting') === -1,
);

// =====================================================================
// 5. OSS mode · synthetic local caller keeps access to their own runs
// =====================================================================
console.log('\n[5] OSS mode · local self-host back-compat');
// Flip cloud mode off so resolveUserContext returns the OSS synthetic ctx.
delete process.env.FLOOM_CLOUD_MODE;
auth._resetAuthForTests();
// Seed a run for a specific device so we can verify device-scoped OSS
// anon access works (stable device cookie reused across requests).
insertRun({
  app_id: localAppId,
  workspace_id: 'local',
  user_id: null,
  device_id: 'dev-ossbox-test',
  inputs: { n: 2 },
  outputs: { greeting: 'hello-ossbox' },
});
r = await fetchRoute(hubRouter, 'GET', '/seed-local/runs', {
  cookie: 'floom_device=dev-ossbox-test',
});
log('OSS local: 200 OK', r.status === 200, `got ${r.status}`);
log(
  'OSS local: sees their own device run',
  r.text.indexOf('hello-ossbox') !== -1,
);
log(
  'OSS local: does NOT see another device run',
  r.text.indexOf('ANON-SECRET') === -1,
);

// ---- summary ----
console.log(`\n${passed + failed} checks, ${passed} passed, ${failed} failed`);
rmSync(tmp, { recursive: true, force: true });
if (failed > 0) process.exit(1);
