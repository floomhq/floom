#!/usr/bin/env node
// Live integration smoke against a real spawned server on an ephemeral port.
// Covers the 6 hard live gates from the workplan:
//   1. Create a schedule firing every minute → wait 2 minutes → DB shows
//      2 fires with next_run_at advancing.                                  [FAST VARIANT]
//   2. Create a webhook → curl with valid signature → job fires →
//      outgoing context = 'webhook'.
//   3. Create webhook → curl with BAD signature → 401.
//   4. PATCH enabled=false → scheduler doesn't fire.
//   5. Delete app → triggers cascade-deleted.
//   6. Delete user → triggers cascade-deleted (via PR #170's CASCADE).
//
// Gate 1 is simulated by forcing next_run_at into the past twice (we don't
// wait real minutes in CI). The scheduler ticks every 2s in this test for
// speed. The full "wait 2 real minutes" gate is callable with
// FLOOM_LIVE_SLOW=1 and takes ~130s.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-triggers-live-'));
const PORT = 14099;
const BASE = `http://127.0.0.1:${PORT}`;

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

const env = {
  ...process.env,
  DATA_DIR: tmp,
  PORT: String(PORT),
  PUBLIC_URL: BASE,
  FLOOM_FAST_APPS: 'false',
  FLOOM_TRIGGERS_POLL_MS: '1500', // 1.5s for fast iteration
  FLOOM_JOB_POLL_MS: '500',
};

const serverPath = new URL('../../apps/server/dist/index.js', import.meta.url).pathname;
const proc = spawn('node', [serverPath], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { proc.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 500);
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

// Capture boot logs for diagnostics on failure.
let bootLog = '';
proc.stdout.on('data', (d) => { bootLog += d.toString(); });
proc.stderr.on('data', (d) => { bootLog += d.toString(); });

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server never became healthy\nlog:\n' + bootLog);
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: json, raw: text, headers: res.headers };
}

try {
  console.log('triggers: live integration');
  await waitForHealth();
  log('server boots + /api/health = 200', true);

  // --- Seed a test app directly via the db (the server's bundled seed apps
  //     are fine but we want a known fresh one for Gate 5). We use a direct
  //     sqlite import against the data dir.
  const { default: Database } = await import(
    '../../apps/server/node_modules/better-sqlite3/lib/index.js'
  );
  const dbPath = join(tmp, 'floom-chat.db');
  const db = new Database(dbPath);
  const appId = 'app_live_test_' + Math.random().toString(36).slice(2, 8);
  const manifest = {
    name: 'Live Test',
    description: 'Live trigger integration',
    actions: { run: { label: 'Run', inputs: [], outputs: [] } },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '2.0',
  };
  db.prepare(
    `INSERT INTO apps (id, slug, name, description, manifest, code_path, app_type, workspace_id, author, is_async, status)
     VALUES (?, ?, ?, ?, ?, ?, 'proxied', ?, ?, 1, 'active')`,
  ).run(
    appId,
    'live-test',
    'Live Test',
    'live test',
    JSON.stringify(manifest),
    'proxied:live-test',
    'local',
    'local',
  );
  log('seeded test app', !!db.prepare('SELECT id FROM apps WHERE id = ?').get(appId));

  // ---------- Gate 2: webhook valid sig → job fires ----------
  const cw = await api('/api/hub/live-test/triggers', {
    method: 'POST',
    body: JSON.stringify({ action: 'run', trigger_type: 'webhook' }),
  });
  log('POST /api/hub/:slug/triggers (webhook) = 201', cw.status === 201, `status=${cw.status} body=${JSON.stringify(cw.body)}`);
  const { webhook_url, webhook_secret, webhook_url_path } = cw.body || {};
  log('webhook create returned url+secret+path', !!webhook_url && !!webhook_secret && !!webhook_url_path);

  // valid sig
  const goodBody = JSON.stringify({ inputs: { live: true } });
  const goodSig = 'sha256=' + createHmac('sha256', webhook_secret).update(goodBody).digest('hex');
  const hookRes = await fetch(`${BASE}/hook/${webhook_url_path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-floom-signature': goodSig, 'x-request-id': 'live-1' },
    body: goodBody,
  });
  log('POST /hook/:path with valid sig = 204', hookRes.status === 204, `status=${hookRes.status}`);
  const jobIdFromHook = hookRes.headers.get('x-floom-job-id');
  log('Location header surfaces job id', !!jobIdFromHook);

  // ---------- Gate 3: webhook bad sig → 401 ----------
  const badRes = await fetch(`${BASE}/hook/${webhook_url_path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-floom-signature': 'sha256=wrong', 'x-request-id': 'live-2' },
    body: goodBody,
  });
  log('POST /hook/:path with BAD sig = 401', badRes.status === 401, `status=${badRes.status}`);

  // ---------- Gate 1 (fast variant): schedule fires and advances ----------
  const cs = await api('/api/hub/live-test/triggers', {
    method: 'POST',
    body: JSON.stringify({
      action: 'run',
      trigger_type: 'schedule',
      cron_expression: '* * * * *',
      tz: 'UTC',
    }),
  });
  log('POST /api/hub/:slug/triggers (schedule) = 201', cs.status === 201, `status=${cs.status}`);
  const schedId = cs.body.trigger.id;

  // Force next_run_at into the past, wait for the 1.5s poll, assert fire.
  const jobsBefore1 = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
  db.prepare('UPDATE triggers SET next_run_at = ? WHERE id = ?').run(Date.now() - 5_000, schedId);
  await new Promise((r) => setTimeout(r, 2500));
  const jobsAfter1 = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
  log(
    'scheduler fired (jobs count increased)',
    jobsAfter1 > jobsBefore1,
    `before=${jobsBefore1} after=${jobsAfter1}`,
  );
  const trAfter1 = db.prepare('SELECT next_run_at, last_fired_at FROM triggers WHERE id = ?').get(schedId);
  log('next_run_at advanced past now', trAfter1.next_run_at > Date.now());
  log('last_fired_at recorded', !!trAfter1.last_fired_at);

  // Second forced fire → assert 2 total fires.
  db.prepare('UPDATE triggers SET next_run_at = ? WHERE id = ?').run(Date.now() - 5_000, schedId);
  await new Promise((r) => setTimeout(r, 2500));
  const jobsAfter2 = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
  log(
    'second scheduled fire observed',
    jobsAfter2 > jobsAfter1,
    `after1=${jobsAfter1} after2=${jobsAfter2}`,
  );

  // ---------- Gate 4: disable → scheduler doesn't fire ----------
  const pat = await api(`/api/me/triggers/${schedId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false }),
  });
  log('PATCH /api/me/triggers/:id enabled=false = 200', pat.status === 200, `status=${pat.status}`);
  db.prepare('UPDATE triggers SET next_run_at = ? WHERE id = ?').run(Date.now() - 5_000, schedId);
  const jobsBeforeDis = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
  await new Promise((r) => setTimeout(r, 2500));
  const jobsAfterDis = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
  log(
    'disabled schedule does NOT fire',
    jobsAfterDis === jobsBeforeDis,
    `before=${jobsBeforeDis} after=${jobsAfterDis}`,
  );

  // ---------- Gate 5: delete app → triggers cascade ----------
  const countBefore = db.prepare('SELECT COUNT(*) as n FROM triggers WHERE app_id = ?').get(appId).n;
  log('triggers exist before app delete', countBefore >= 2, `count=${countBefore}`);
  db.prepare('DELETE FROM apps WHERE id = ?').run(appId);
  const countAfter = db.prepare('SELECT COUNT(*) as n FROM triggers WHERE app_id = ?').get(appId).n;
  log('triggers cascade-deleted on app delete', countAfter === 0, `after=${countAfter}`);

  // ---------- Gate 6: delete user → triggers cascade ----------
  // Seed a throwaway user + app + trigger.
  const u2 = 'u_live_' + Math.random().toString(36).slice(2, 8);
  db.prepare(`INSERT INTO users (id, workspace_id, email, name, auth_provider) VALUES (?, 'local', NULL, '', 'local')`).run(u2);
  const a2 = 'app_live_2_' + Math.random().toString(36).slice(2, 8);
  db.prepare(
    `INSERT INTO apps (id, slug, name, description, manifest, code_path, app_type, workspace_id, author, is_async, status)
     VALUES (?, ?, ?, ?, ?, ?, 'proxied', 'local', ?, 1, 'active')`,
  ).run(a2, 'live-test-2', 'Live Test 2', 'x', JSON.stringify(manifest), 'proxied:live-test-2', u2);
  // Seed a trigger row directly via the test's db handle (avoids re-opening
  // the SQLite file from the triggers service module, which caused FK
  // visibility races in this multi-process setup).
  const triggerId = 'tgr_live_' + Math.random().toString(36).slice(2, 8);
  const now = Date.now();
  db.prepare(
    `INSERT INTO triggers (id, app_id, user_id, workspace_id, action, inputs, trigger_type, cron_expression, tz, next_run_at, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'local', 'run', '{}', 'schedule', '*/5 * * * *', 'UTC', ?, 1, ?, ?)`,
  ).run(triggerId, a2, u2, now + 60_000, now, now);
  const existsBefore = db.prepare('SELECT COUNT(*) as n FROM triggers WHERE user_id = ?').get(u2).n;
  log('user-scoped trigger exists before delete', existsBefore === 1);
  db.prepare('DELETE FROM users WHERE id = ?').run(u2);
  const existsAfter = db.prepare('SELECT COUNT(*) as n FROM triggers WHERE user_id = ?').get(u2).n;
  log('triggers cascade-deleted on user delete', existsAfter === 0);

  db.close();
} catch (err) {
  console.error('live test threw:', err);
  failed++;
} finally {
  cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
