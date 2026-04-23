#!/usr/bin/env node
// Auth + aggregation test for GET /api/hub/:slug/runs-by-day?days=N.
//
// This endpoint powers the per-card sparkline on /studio · My apps. It is
// creator-only — runs-by-day tells a creator "did my app get traction
// this week?", so non-owners must NOT see the shape of someone else's
// traffic (even as zero-counts it would reveal presence).
//
// Asserts (Cloud mode):
//   1. Anon → 401 Unauthorized.
//   2. Non-owner → 403 not_owner.
//   3. Owner → 200 with `days.length === N`, oldest → newest, zero-filled.
//   4. Counts aggregate correctly across multiple runs on the same day.
//
// Asserts (OSS mode):
//   5. Synthetic local caller sees runs for a 'local'/'local' app.
//
// Run: node test/stress/test-hub-runs-by-day.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-hub-runs-by-day-'));
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

console.log('Hub · /:slug/runs-by-day auth + aggregation');

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

// Insert a run pinned to a specific UTC day offset (0 = today, 1 = yesterday).
// We use datetime(... , '-N days') so the row's started_at lands in the
// expected UTC window regardless of the test host's TZ.
function insertRunOnDay({ app_id, workspace_id, user_id, device_id, daysAgo }) {
  const id = `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  db.prepare(
    `INSERT INTO runs (id, app_id, action, status, inputs, outputs,
                       duration_ms, started_at, workspace_id, user_id, device_id)
     VALUES (?, ?, 'run', 'success', '{}', '{}', 5,
             datetime('now', '-${Number(daysAgo)} days'),
             ?, ?, ?)`,
  ).run(id, app_id, workspace_id, user_id, device_id);
  return id;
}

// ---- seed ----
seedUser('user-alice', 'alice@example.com', 'Alice');
seedUser('user-bob', 'bob@example.com', 'Bob');
seedWorkspace('ws-alice', 'alice-ws', 'user-alice');
seedWorkspace('ws-bob', 'bob-ws', 'user-bob');

// Alice owns spark-app. She ran it today twice + yesterday once + 3 days ago once.
// Day 4, 5, 6 had no runs — must come back as zero-count, not missing.
const sparkAppId = insertApp({
  slug: 'spark-app',
  workspace_id: 'ws-alice',
  author: 'user-alice',
});
insertRunOnDay({
  app_id: sparkAppId,
  workspace_id: 'ws-alice',
  user_id: 'user-alice',
  device_id: 'dev-alice',
  daysAgo: 0,
});
insertRunOnDay({
  app_id: sparkAppId,
  workspace_id: 'ws-alice',
  user_id: 'user-alice',
  device_id: 'dev-alice',
  daysAgo: 0,
});
insertRunOnDay({
  app_id: sparkAppId,
  workspace_id: 'ws-bob',
  user_id: 'user-bob',
  device_id: 'dev-bob',
  daysAgo: 1,
});
insertRunOnDay({
  app_id: sparkAppId,
  workspace_id: 'ws-alice',
  user_id: 'user-alice',
  device_id: 'dev-alice',
  daysAgo: 3,
});
// 8 days ago should be EXCLUDED from a 7-day window (today + last 6 days).
insertRunOnDay({
  app_id: sparkAppId,
  workspace_id: 'ws-alice',
  user_id: 'user-alice',
  device_id: 'dev-alice',
  daysAgo: 8,
});

// 'local'/'local' app for the OSS-mode branch.
const localAppId = insertApp({
  slug: 'spark-local',
  workspace_id: 'local',
  author: 'local',
});
insertRunOnDay({
  app_id: localAppId,
  workspace_id: 'local',
  user_id: null,
  device_id: 'dev-ossbox',
  daysAgo: 0,
});

// ---- Better Auth stub ----
auth._resetAuthForTests();
const a = auth.getAuth();
let fakeUser = null;
a.api.getSession = async () => {
  if (!fakeUser) return null;
  return { user: fakeUser, session: { id: 'sess_fake' } };
};

// =====================================================================
// 1. Anon → 401
// =====================================================================
console.log('\n[1] Cloud mode anon caller → 401');
fakeUser = null;
let r = await fetchRoute(hubRouter, 'GET', '/spark-app/runs-by-day?days=7');
log('anon caller: 401 Unauthorized', r.status === 401, `got ${r.status}`);

// =====================================================================
// 2. Non-owner → 403
// =====================================================================
console.log('\n[2] Authed non-owner Bob → 403 not_owner');
fakeUser = { id: 'user-bob', email: 'bob@example.com', name: 'Bob' };
r = await fetchRoute(hubRouter, 'GET', '/spark-app/runs-by-day?days=7');
log('Bob: 403 Forbidden', r.status === 403, `got ${r.status}`);
log('Bob: error code is not_owner', r.json?.code === 'not_owner');

// =====================================================================
// 3. Owner → 200, shape is correct
// =====================================================================
console.log('\n[3] Authed owner Alice → 200');
fakeUser = { id: 'user-alice', email: 'alice@example.com', name: 'Alice' };
r = await fetchRoute(hubRouter, 'GET', '/spark-app/runs-by-day?days=7');
log('Alice: 200 OK', r.status === 200, `got ${r.status}`);
const days = r.json?.days;
log('Alice: response.days is an array', Array.isArray(days));
log(
  'Alice: days.length === 7 (zero-filled)',
  Array.isArray(days) && days.length === 7,
  `len=${days?.length}`,
);
log(
  'Alice: every entry has {date, count}',
  Array.isArray(days) &&
    days.every((d) => typeof d.date === 'string' && typeof d.count === 'number'),
);
log(
  'Alice: dates are sorted oldest → newest',
  Array.isArray(days) &&
    days.every((d, i) => i === 0 || days[i - 1].date < d.date),
);

// =====================================================================
// 4. Counts aggregate correctly
// =====================================================================
console.log('\n[4] Day-bucket aggregation');
// Use UTC day keys so the assertion is TZ-independent.
const nowUtc = new Date();
function utcDayKey(daysAgo) {
  const d = new Date(Date.UTC(
    nowUtc.getUTCFullYear(),
    nowUtc.getUTCMonth(),
    nowUtc.getUTCDate() - daysAgo,
  ));
  return d.toISOString().slice(0, 10);
}
const byDate = new Map(days.map((d) => [d.date, d.count]));
// today (daysAgo=0) had 2 runs, both from Alice. Bob ran at daysAgo=1,
// not today. The endpoint counts cross-caller (it's the owner's
// traction dashboard, not a per-user filter) but the seed data only
// has 2 today-runs total.
log(
  `today (${utcDayKey(0)}) count === 2 (both Alice runs)`,
  byDate.get(utcDayKey(0)) === 2,
  `got ${byDate.get(utcDayKey(0))}`,
);
log(
  `yesterday (${utcDayKey(1)}) count === 1 (Bob's run)`,
  byDate.get(utcDayKey(1)) === 1,
  `got ${byDate.get(utcDayKey(1))}`,
);
log(
  `3 days ago (${utcDayKey(3)}) count === 1`,
  byDate.get(utcDayKey(3)) === 1,
  `got ${byDate.get(utcDayKey(3))}`,
);
log(
  `2 days ago (${utcDayKey(2)}) count === 0 (zero-fill)`,
  byDate.get(utcDayKey(2)) === 0,
  `got ${byDate.get(utcDayKey(2))}`,
);
// 8 days ago — outside the 7-day window, should not be present at all.
log(
  `8-day-old run is OUTSIDE window (not present in days array)`,
  !byDate.has(utcDayKey(8)),
);

// =====================================================================
// 5. OSS mode: local caller sees their local app
// =====================================================================
console.log('\n[5] OSS mode · local self-host back-compat');
delete process.env.FLOOM_CLOUD_MODE;
auth._resetAuthForTests();
r = await fetchRoute(hubRouter, 'GET', '/spark-local/runs-by-day?days=7');
log('OSS local: 200 OK', r.status === 200, `got ${r.status}`);
log(
  'OSS local: days.length === 7',
  Array.isArray(r.json?.days) && r.json.days.length === 7,
  `len=${r.json?.days?.length}`,
);
const localByDate = new Map((r.json?.days ?? []).map((d) => [d.date, d.count]));
log(
  'OSS local: today count === 1',
  localByDate.get(utcDayKey(0)) === 1,
  `got ${localByDate.get(utcDayKey(0))}`,
);

// ---- summary ----
console.log(`\n${passed + failed} checks, ${passed} passed, ${failed} failed`);
rmSync(tmp, { recursive: true, force: true });
if (failed > 0) process.exit(1);
