#!/usr/bin/env node
// Visibility audit log: every transition writes actor, reason, before/after.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-sharing-audit-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';

const { db } = await import('../../apps/server/dist/db.js');
const { adminRouter } = await import('../../apps/server/dist/routes/admin.js');
const { transitionVisibility } = await import('../../apps/server/dist/services/sharing.js');

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

function insertApp() {
  const id = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path, author, workspace_id, app_type, visibility)
     VALUES (?, 'audit-app', 'Audit App', 'test app', ?, 'active', 'proxied:test', 'local', 'local', 'proxied', 'private')`,
  ).run(id, JSON.stringify({ name: 'Audit App', actions: {}, secrets_needed: [] }));
  return id;
}

function load(id) {
  return db.prepare(`SELECT * FROM apps WHERE id = ?`).get(id);
}

async function auditEndpoint(appId) {
  db.prepare(`UPDATE users SET is_admin = 1 WHERE id = 'local'`).run();
  const res = await adminRouter.fetch(new Request(`http://localhost/audit-log?app_id=${appId}`));
  const json = await res.json();
  return { status: res.status, json };
}

console.log('Sharing · audit log');
const id = insertApp();
let app = await transitionVisibility(load(id), 'link', { actorUserId: 'local', reason: 'owner_enable_link' });
app = await transitionVisibility(app, 'private', { actorUserId: 'local', reason: 'owner_set_private' });
app = await transitionVisibility(app, 'pending_review', { actorUserId: 'local', reason: 'owner_submit_review' });
app = await transitionVisibility(app, 'changes_requested', {
  actorUserId: 'local',
  reason: 'admin_reject',
  comment: 'Needs polish.',
});

const rows = db
  .prepare(`SELECT * FROM app_visibility_audit WHERE app_id = ?`)
  .all(id);
log('one row per transition', rows.length === 4, `got ${rows.length}`);
const linkRow = rows.find((row) => row.from_state === 'private' && row.to_state === 'link');
const rejectRow = rows.find((row) => row.reason === 'admin_reject');
log('captures before and after', Boolean(linkRow));
log('captures actor and reason', rejectRow?.actor_user_id === 'local' && rejectRow?.reason === 'admin_reject');
log('captures metadata comment', JSON.parse(rejectRow?.metadata || '{}').comment === 'Needs polish.');

const endpoint = await auditEndpoint(id);
log('admin audit endpoint returns rows', endpoint.status === 200 && endpoint.json.audit_log.length === 4);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
