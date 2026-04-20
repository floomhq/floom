#!/usr/bin/env node
// E2E smoke test for the schedule side of the unified triggers system.
//
// Does not spin up an HTTP server — drives the service + worker functions
// directly against a throwaway DB. Covers:
//
//   1. createTrigger(schedule) persists + computes next_run_at.
//   2. tickOnce() fires ready triggers and advances next_run_at.
//   3. Disable → tickOnce skips.
//   4. Delete app → trigger cascade-deleted.
//   5. Delete user → trigger cascade-deleted.
//   6. Catch-up: > 1h drift resets without firing.
//
// Run: node test/stress/test-triggers-schedule.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-triggers-sched-test-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';

const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = await import(
  '../../apps/server/dist/db.js'
);
const { newAppId } = await import('../../apps/server/dist/lib/ids.js');
const triggers = await import('../../apps/server/dist/services/triggers.js');
const worker = await import('../../apps/server/dist/services/triggers-worker.js');

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

// --- fixture: a tiny proxied app with one action ---
const appId = newAppId();
const manifest = {
  name: 'Echo',
  description: 'Test',
  actions: {
    run: { label: 'Run', inputs: [], outputs: [] },
    other: { label: 'Other', inputs: [], outputs: [] },
  },
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
  'sched-echo',
  'Sched Echo',
  'Schedule test app',
  JSON.stringify(manifest),
  'proxied:sched-echo',
  DEFAULT_WORKSPACE_ID,
  DEFAULT_USER_ID,
);

console.log('triggers: schedule tests');

// 1. Create a schedule trigger and assert next_run_at is in the future.
const t1 = triggers.createTrigger({
  app_id: appId,
  user_id: DEFAULT_USER_ID,
  workspace_id: DEFAULT_WORKSPACE_ID,
  action: 'run',
  inputs: { foo: 'bar' },
  trigger_type: 'schedule',
  cron_expression: '*/1 * * * *', // every minute
  tz: 'UTC',
});
log(
  'createTrigger(schedule): persisted',
  !!t1 && t1.trigger_type === 'schedule',
  JSON.stringify(t1),
);
log(
  'createTrigger(schedule): next_run_at in the future',
  typeof t1.next_run_at === 'number' && t1.next_run_at > Date.now(),
  `next=${t1.next_run_at}`,
);
log(
  'createTrigger(schedule): webhook fields null',
  t1.webhook_secret === null && t1.webhook_url_path === null,
);
log(
  'createTrigger(schedule): enabled=1 by default',
  t1.enabled === 1,
);

// 2. Force next_run_at to 1s ago, then call tickOnce and assert it fired.
db.prepare('UPDATE triggers SET next_run_at = ? WHERE id = ?').run(
  Date.now() - 1_000,
  t1.id,
);
const firedCount = worker.tickOnce();
log(
  'tickOnce: fires when next_run_at <= now',
  firedCount === 1,
  `fired=${firedCount}`,
);
const t1After = triggers.getTrigger(t1.id);
log(
  'tickOnce: next_run_at advanced',
  t1After.next_run_at > Date.now(),
  `next=${t1After.next_run_at}`,
);
log(
  'tickOnce: last_fired_at recorded',
  typeof t1After.last_fired_at === 'number' && t1After.last_fired_at > 0,
);

const jobCount1 = db
  .prepare('SELECT COUNT(*) as n FROM jobs WHERE app_id = ?')
  .get(appId).n;
log(
  'tickOnce: a job was enqueued',
  jobCount1 === 1,
  `jobs=${jobCount1}`,
);

// 3. Disable the trigger, force next_run_at into the past again, tick.
//    Nothing should fire.
triggers.updateTrigger(t1.id, { enabled: false });
db.prepare('UPDATE triggers SET next_run_at = ? WHERE id = ?').run(
  Date.now() - 1_000,
  t1.id,
);
const firedCount2 = worker.tickOnce();
log(
  'tickOnce: disabled trigger does NOT fire',
  firedCount2 === 0,
  `fired=${firedCount2}`,
);
const jobCount2 = db
  .prepare('SELECT COUNT(*) as n FROM jobs WHERE app_id = ?')
  .get(appId).n;
log(
  'tickOnce: no extra job enqueued while disabled',
  jobCount2 === 1,
  `jobs=${jobCount2}`,
);

// Re-enable for next checks.
triggers.updateTrigger(t1.id, { enabled: true });

// 4. Update cron via PATCH and assert next_run_at recomputed.
const before = triggers.getTrigger(t1.id).next_run_at;
await new Promise((r) => setTimeout(r, 50));
triggers.updateTrigger(t1.id, { cron_expression: '0 0 1 1 *' }); // once a year
const after = triggers.getTrigger(t1.id).next_run_at;
log(
  'updateTrigger: cron_expression change recomputes next_run_at',
  after !== before,
  `before=${before} after=${after}`,
);

// 5. Catch-up: drift > 1h → reset without firing.
const catchUpAppId = newAppId();
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, app_type, workspace_id, author, is_async, status)
   VALUES (?, ?, ?, ?, ?, ?, 'proxied', ?, ?, 1, 'active')`,
).run(
  catchUpAppId,
  'catchup-echo',
  'Catchup',
  'Catch up test',
  JSON.stringify(manifest),
  'proxied:catchup',
  DEFAULT_WORKSPACE_ID,
  DEFAULT_USER_ID,
);
const tDrift = triggers.createTrigger({
  app_id: catchUpAppId,
  user_id: DEFAULT_USER_ID,
  workspace_id: DEFAULT_WORKSPACE_ID,
  action: 'run',
  inputs: {},
  trigger_type: 'schedule',
  cron_expression: '*/1 * * * *',
  tz: 'UTC',
});
// 2h ago
const TWO_H = 2 * 60 * 60 * 1000;
db.prepare('UPDATE triggers SET next_run_at = ? WHERE id = ?').run(
  Date.now() - TWO_H,
  tDrift.id,
);
const jobsBeforeDrift = db
  .prepare('SELECT COUNT(*) as n FROM jobs WHERE app_id = ?')
  .get(catchUpAppId).n;
worker.tickOnce();
const jobsAfterDrift = db
  .prepare('SELECT COUNT(*) as n FROM jobs WHERE app_id = ?')
  .get(catchUpAppId).n;
log(
  'catch-up: no job fired for > 1h drifted trigger',
  jobsAfterDrift === jobsBeforeDrift,
  `before=${jobsBeforeDrift} after=${jobsAfterDrift}`,
);
const tDriftAfter = triggers.getTrigger(tDrift.id);
log(
  'catch-up: next_run_at reset to the future',
  tDriftAfter.next_run_at > Date.now(),
);

// 6. Cascade: delete the APP → triggers cascade-deleted.
const beforeDelete = db
  .prepare('SELECT COUNT(*) as n FROM triggers WHERE app_id = ?')
  .get(appId).n;
log('before app delete: trigger exists', beforeDelete === 1);
db.prepare('DELETE FROM apps WHERE id = ?').run(appId);
const afterDelete = db
  .prepare('SELECT COUNT(*) as n FROM triggers WHERE app_id = ?')
  .get(appId).n;
log(
  'cascade: trigger removed when app deleted',
  afterDelete === 0,
  `after=${afterDelete}`,
);

// 7. Cascade: delete the USER → triggers cascade-deleted.
// Create a throwaway user + app + trigger to test user CASCADE.
const cascadeAppId = newAppId();
const cascadeUserId = 'tgr_test_user_' + Math.random().toString(36).slice(2, 10);
db.prepare(
  `INSERT INTO users (id, workspace_id, email, name, auth_provider) VALUES (?, ?, NULL, '', 'local')`,
).run(cascadeUserId, DEFAULT_WORKSPACE_ID);
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, app_type, workspace_id, author, is_async, status)
   VALUES (?, ?, ?, ?, ?, ?, 'proxied', ?, ?, 1, 'active')`,
).run(
  cascadeAppId,
  'cascade-user-app',
  'Cascade user app',
  'd',
  JSON.stringify(manifest),
  'proxied:cascade',
  DEFAULT_WORKSPACE_ID,
  cascadeUserId,
);
const cascadeTrig = triggers.createTrigger({
  app_id: cascadeAppId,
  user_id: cascadeUserId,
  workspace_id: DEFAULT_WORKSPACE_ID,
  action: 'run',
  inputs: {},
  trigger_type: 'schedule',
  cron_expression: '*/1 * * * *',
  tz: 'UTC',
});
db.prepare('DELETE FROM users WHERE id = ?').run(cascadeUserId);
const afterUserDelete = db
  .prepare('SELECT COUNT(*) as n FROM triggers WHERE id = ?')
  .get(cascadeTrig.id).n;
log(
  'cascade: trigger removed when user deleted',
  afterUserDelete === 0,
  `after=${afterUserDelete}`,
);

// Cleanup temp DB
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
