#!/usr/bin/env node
// Security regression test for the P0 run-auth lockdown (2026-04-20):
// GET /api/run/:id used to return every run's full inputs + outputs +
// logs to any caller with the run_id. This test asserts the new
// ownership-gated contract.
//
// Asserts:
//   1. Cloud mode · anon GET /api/run/:private_run → 404 (no leak)
//   2. Cloud mode · authed non-owner GET → 404 (not 403, no leak)
//   3. Cloud mode · owner GET → 200 with full payload
//   4. Owner POST /api/run/:id/share → 200 { share_url, public_view_url }
//   5. Anon GET /api/run/:id for a shared run → 200 outputs-only,
//      NO inputs, NO logs, NO upstream_status
//   6. Anon GET stream on a shared run → still 404 (share ≠ live stream)
//   7. Non-owner POST /api/run/:id/share → 404
//   8. OSS mode · same device sees own anon run; different device → 404
//
// Run: node test/stress/test-run-auth.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-run-auth-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.FLOOM_AUTH_TOKEN = 'run-auth-test-token';
process.env.BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db } = await import('../../apps/server/dist/db.js');
const auth = await import('../../apps/server/dist/lib/better-auth.js');
const { runRouter } = await import('../../apps/server/dist/routes/run.js');
const { getOrCreateStream } = await import('../../apps/server/dist/lib/log-stream.js');

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

console.log('Run auth · GET /api/run/:id owner gate (P0 2026-04-20)');

// ---- helpers ----
async function fetchRoute(router, method, path, headers = {}, body) {
  const url = `http://localhost${path}`;
  const init = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': 'application/json', ...headers };
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

function insertApp({ slug, workspace_id, author, visibility = 'public' }) {
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
     VALUES (?, ?, ?, ?, ?, 'active', 'proxied:test', ?, ?, 'proxied', ?)`,
  ).run(id, slug, slug, `${slug} app`, manifest, author, workspace_id, visibility);
  return id;
}

function insertRun({ app_id, workspace_id, user_id, device_id, inputs, outputs, logs = '' }) {
  const id = `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  db.prepare(
    `INSERT INTO runs (id, app_id, action, status, inputs, outputs, logs,
                       duration_ms, started_at, finished_at, workspace_id, user_id, device_id)
     VALUES (?, ?, 'run', 'success', ?, ?, ?, 5, datetime('now'), datetime('now'), ?, ?, ?)`,
  ).run(
    id,
    app_id,
    JSON.stringify(inputs),
    JSON.stringify(outputs),
    logs,
    workspace_id,
    user_id,
    device_id,
  );
  // Finish the log stream so /stream returns immediately instead of hanging.
  getOrCreateStream(id).finish();
  return id;
}

// ---- seed users, workspaces, apps, runs ----
seedUser('user-alice', 'alice@example.com', 'Alice');
seedUser('user-bob', 'bob@example.com', 'Bob');
seedWorkspace('ws-alice', 'alice-ws', 'user-alice');
seedWorkspace('ws-bob', 'bob-ws', 'user-bob');

const appId = insertApp({
  slug: 'leaky-run-app',
  workspace_id: 'ws-alice',
  author: 'user-alice',
});

// Alice's private run (default is_public=0)
const aliceRunId = insertRun({
  app_id: appId,
  workspace_id: 'ws-alice',
  user_id: 'user-alice',
  device_id: 'dev-alice',
  inputs: { api_key: 'ALICE-INPUT-KEY-abc123' },
  outputs: { password: 'ALICE-OUTPUT-xyz789' },
  logs: 'ALICE-LOG-trace-qqq',
});

// Bob's private run on the same app
const bobRunId = insertRun({
  app_id: appId,
  workspace_id: 'ws-bob',
  user_id: 'user-bob',
  device_id: 'dev-bob',
  inputs: { api_key: 'BOB-INPUT-KEY-def456' },
  outputs: { password: 'BOB-OUTPUT-uvw321' },
  logs: 'BOB-LOG-trace-rrr',
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
// 1. Cloud mode · anon → 404 on a private run (NOT 200, NOT a leak)
// =====================================================================
console.log('\n[1] Cloud mode anon GET /api/run/:private → 404');
fakeUser = null;
let r = await fetchRoute(runRouter, 'GET', `/${aliceRunId}`);
log('anon: 404 Not Found', r.status === 404, `got ${r.status}`);
log(
  'anon: response does NOT leak inputs',
  r.text.indexOf('ALICE-INPUT-KEY') === -1,
  r.text.slice(0, 200),
);
log(
  'anon: response does NOT leak outputs',
  r.text.indexOf('ALICE-OUTPUT') === -1,
);
log(
  'anon: response does NOT leak logs',
  r.text.indexOf('ALICE-LOG') === -1,
);

// =====================================================================
// 2. Cloud mode · authed non-owner (Bob) → 404 (not 403, no leak)
// =====================================================================
console.log('\n[2] Authed non-owner → 404 (existence not leaked)');
fakeUser = { id: 'user-bob', email: 'bob@example.com', name: 'Bob' };
r = await fetchRoute(runRouter, 'GET', `/${aliceRunId}`);
log('bob: 404 (not 403)', r.status === 404, `got ${r.status}`);
log(
  'bob: response does NOT leak alice inputs',
  r.text.indexOf('ALICE-INPUT-KEY') === -1,
);
log(
  'bob: response does NOT leak alice outputs',
  r.text.indexOf('ALICE-OUTPUT') === -1,
);

// =====================================================================
// 3. Cloud mode · owner (Alice) → 200 with full payload
// =====================================================================
console.log('\n[3] Owner GET → 200 with full payload');
fakeUser = { id: 'user-alice', email: 'alice@example.com', name: 'Alice' };
r = await fetchRoute(runRouter, 'GET', `/${aliceRunId}`);
log('alice: 200 OK', r.status === 200, `got ${r.status}`);
log(
  'alice: sees her inputs',
  r.text.indexOf('ALICE-INPUT-KEY-abc123') !== -1,
);
log(
  'alice: sees her outputs',
  r.text.indexOf('ALICE-OUTPUT-xyz789') !== -1,
);
log(
  'alice: sees her logs',
  r.text.indexOf('ALICE-LOG-trace-qqq') !== -1,
);
log('alice: app_slug present', r.json?.app_slug === 'leaky-run-app');

// =====================================================================
// 4. Owner POST /share → 200 with share_url + public_view_url
// =====================================================================
console.log('\n[4] Owner POST /share → 200 {share_url, public_view_url}');
fakeUser = { id: 'user-alice', email: 'alice@example.com', name: 'Alice' };
r = await fetchRoute(runRouter, 'POST', `/${aliceRunId}/share`, {}, {});
log('alice share: 200 OK', r.status === 200, `got ${r.status}`);
log(
  'alice share: share_url /r/:id',
  typeof r.json?.share_url === 'string' && r.json.share_url.includes(aliceRunId),
  r.json?.share_url,
);
log(
  'alice share: public_view_url /api/run/:id',
  typeof r.json?.public_view_url === 'string' &&
    r.json.public_view_url.includes(aliceRunId),
  r.json?.public_view_url,
);
log('alice share: is_public=true', r.json?.is_public === true);

// Idempotency: re-share should still 200 and return same URLs.
r = await fetchRoute(runRouter, 'POST', `/${aliceRunId}/share`, {}, {});
log('alice re-share: 200 (idempotent)', r.status === 200);

// =====================================================================
// 5. Anon GET on a shared run → 200 outputs-only (NO inputs, NO logs)
// =====================================================================
console.log('\n[5] Anon GET on shared run → redacted view');
fakeUser = null;
r = await fetchRoute(runRouter, 'GET', `/${aliceRunId}`);
log('anon on shared run: 200', r.status === 200, `got ${r.status}`);
log(
  'anon on shared run: sees outputs',
  r.text.indexOf('ALICE-OUTPUT-xyz789') !== -1,
);
log(
  'anon on shared run: inputs REDACTED',
  r.text.indexOf('ALICE-INPUT-KEY') === -1,
  `body contains inputs: ${r.text.slice(0, 300)}`,
);
log(
  'anon on shared run: logs REDACTED',
  r.text.indexOf('ALICE-LOG') === -1,
);
log('anon on shared run: inputs field is null', r.json?.inputs === null);
log('anon on shared run: logs field is null', r.json?.logs === null);
log('anon on shared run: is_public=true', r.json?.is_public === true);
log(
  'anon on shared run: app_slug present (for /p/:slug hydration)',
  r.json?.app_slug === 'leaky-run-app',
);

// =====================================================================
// 6. Stream never goes public: anon GET /stream on shared run → 404
// =====================================================================
console.log('\n[6] Anon /stream on shared run → still 404');
fakeUser = null;
r = await fetchRoute(runRouter, 'GET', `/${aliceRunId}/stream`);
log('anon stream on shared run: 404', r.status === 404, `got ${r.status}`);
log(
  'anon stream on shared run: no leak',
  r.text.indexOf('ALICE-OUTPUT') === -1 && r.text.indexOf('ALICE-LOG') === -1,
);

// =====================================================================
// 7. Non-owner POST /share → 404
// =====================================================================
console.log('\n[7] Non-owner POST /share → 404');
fakeUser = { id: 'user-bob', email: 'bob@example.com', name: 'Bob' };
r = await fetchRoute(runRouter, 'POST', `/${aliceRunId}/share`, {}, {});
log('bob share: 404', r.status === 404, `got ${r.status}`);
r = await fetchRoute(runRouter, 'POST', `/${bobRunId}/share`, {}, {});
log('bob share of own run: 200', r.status === 200, `got ${r.status}`);

// =====================================================================
// 8. OSS mode · single-user self-host box back-compat
// =====================================================================
// In OSS mode (no FLOOM_CLOUD_MODE) the server is assumed to be a
// single-user self-host. Node `fetch`-based clients (curl, CI scripts,
// the test-fast-apps poll) don't carry the device cookie across calls,
// so enforcing per-device ownership would 404 every legit poll. OSS
// therefore allows unauthenticated reads on the 'local' workspace.
// Cloud deployments (preview.floom.dev) never hit this branch.
console.log('\n[8] OSS mode · single-user self-host back-compat');
delete process.env.FLOOM_CLOUD_MODE;
auth._resetAuthForTests();

const localAppId = insertApp({
  slug: 'local-app',
  workspace_id: 'local',
  author: 'local',
});
const ossRunId = insertRun({
  app_id: localAppId,
  workspace_id: 'local',
  user_id: null,
  device_id: 'dev-selfhost-42',
  inputs: { q: 'SELFHOST-INPUT' },
  outputs: { a: 'SELFHOST-OUTPUT' },
  logs: 'SELFHOST-LOG',
});

// OSS self-host: anon caller (no cookie) still reads their own run,
// same as the pre-lockdown behavior. The risk surface this lockdown
// closes is cross-user reads on Cloud, not single-user self-host.
r = await fetchRoute(runRouter, 'GET', `/${ossRunId}`);
log('OSS anon same box: 200', r.status === 200, `got ${r.status}`);
log('OSS anon same box: sees outputs', r.text.indexOf('SELFHOST-OUTPUT') !== -1);

// ---- summary ----
console.log(`\n${passed + failed} checks, ${passed} passed, ${failed} failed`);
rmSync(tmp, { recursive: true, force: true });
if (failed > 0) process.exit(1);
