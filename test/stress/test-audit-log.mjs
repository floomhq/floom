#!/usr/bin/env node
// ADR-013 audit log coverage: writes, admin reads, retention, deletion.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-audit-log-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';
process.env.FLOOM_DISABLE_AUDIT_SWEEPER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db } = await import('../../apps/server/dist/db.js');
const { adminRouter } = await import('../../apps/server/dist/routes/admin.js');
const { agentKeysRouter } = await import('../../apps/server/dist/routes/agent_keys.js');
const { secretsRouter } = await import('../../apps/server/dist/routes/memory.js');
const { transitionVisibility } = await import('../../apps/server/dist/services/sharing.js');
const { cleanupUserOrphans } = await import('../../apps/server/dist/services/cleanup.js');
const {
  auditLog,
  queryAuditLog,
  sweepAuditLogRetention,
} = await import('../../apps/server/dist/services/audit-log.js');

let passed = 0;
let failed = 0;
function log(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

async function call(router, method, path, body, headers = {}) {
  const res = await router.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body
        ? { 'content-type': 'application/json', ...headers }
        : headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

function insertUser(id, email = `${id}@example.com`, name = id, isAdmin = 0) {
  db.prepare(
    `INSERT INTO users (id, workspace_id, email, name, auth_provider, auth_subject, is_admin)
     VALUES (?, 'local', ?, ?, 'test', ?, ?)`,
  ).run(id, email, name, id, isAdmin);
}

function insertApp(slug, visibility = 'private', author = 'local', workspace = 'local') {
  const id = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path, author, workspace_id, app_type,
        visibility, publish_status)
     VALUES (?, ?, ?, 'audit test app', ?, 'active', 'proxied:test', ?, ?, 'proxied', ?, 'pending_review')`,
  ).run(
    id,
    slug,
    slug,
    JSON.stringify({ name: slug, actions: {}, secrets_needed: ['API_KEY'] }),
    author,
    workspace,
    visibility,
  );
  return id;
}

function loadApp(id) {
  return db.prepare(`SELECT * FROM apps WHERE id = ?`).get(id);
}

function latest(action) {
  return db
    .prepare(`SELECT * FROM audit_log WHERE action = ? ORDER BY datetime(created_at) DESC LIMIT 1`)
    .get(action);
}

console.log('ADR-013 audit log');

// Happy paths --------------------------------------------------------
const visibilityAppId = insertApp('audit-visibility');
transitionVisibility(loadApp(visibilityAppId), 'link', {
  actorUserId: 'local',
  reason: 'owner_enable_link',
});
const visibilityRow = latest('app.visibility_changed');
log('visibility change writes audit row', visibilityRow?.target_id === visibilityAppId);

const minted = await call(agentKeysRouter, 'POST', '/', {
  label: 'deploy bot',
  scope: 'publish-only',
  rate_limit_per_minute: 99,
});
const tokenId = minted.json?.id;
const mintRow = latest('agent_token.minted');
log('token mint writes audit row', minted.status === 201 && mintRow?.target_id === tokenId);

const revoked = await call(agentKeysRouter, 'POST', `/${tokenId}/revoke`);
const revokeRow = latest('agent_token.revoked');
log('token revoke writes audit row', revoked.status === 204 && revokeRow?.target_id === tokenId);

const secretSet = await call(secretsRouter, 'POST', '/', {
  key: 'UNICODE_KEY',
  value: 's3cret',
});
const secretRow = latest('secret.updated');
log('secret update writes audit row', secretSet.status === 200 && secretRow?.action === 'secret.updated');

db.prepare(`UPDATE users SET is_admin = 1 WHERE id = 'local'`).run();
const approveAppId = insertApp('audit-approve', 'pending_review');
const approve = await call(adminRouter, 'POST', '/review-queue/audit-approve/approve');
const approveRow = latest('admin.app_approved');
log(
  "admin approve writes action='admin.app_approved'",
  approve.status === 200 && approveRow?.target_id === approveAppId,
  approve.text,
);

insertUser('delete_me', 'delete@example.com', 'Delete Me');
db.prepare(`INSERT INTO workspaces (id, slug, name, plan) VALUES ('ws_delete_me', 'ws-delete-me', 'Delete Me', 'cloud_free')`).run();
db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_delete_me', 'delete_me', 'admin')`).run();
const deleteAppId = insertApp('audit-delete-user-app', 'private', 'delete_me', 'ws_delete_me');
cleanupUserOrphans('delete_me');
const accountDeleted = latest('account.deleted');
const deletedApp = db.prepare(`SELECT id FROM apps WHERE id = ?`).get(deleteAppId);
log('account hard-delete writes audit row', accountDeleted?.target_id === 'delete_me');
log('account hard-delete cascades private app cleanup', !deletedApp);

// Unhappy paths + admin reads ---------------------------------------
db.prepare(`UPDATE users SET is_admin = 0 WHERE id = 'local'`).run();
const nonAdmin = await call(adminRouter, 'GET', '/audit-log');
log('non-admin GET /api/admin/audit-log returns 403', nonAdmin.status === 403, `got ${nonAdmin.status}`);

const previousCloud = process.env.FLOOM_CLOUD_MODE;
const previousBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET = 'audit-log-test-secret-32-bytes-minimum';
const missingAuth = await call(adminRouter, 'GET', '/audit-log');
log('auth missing returns 401 in cloud mode', missingAuth.status === 401, `got ${missingAuth.status}`);
if (previousCloud === undefined) delete process.env.FLOOM_CLOUD_MODE;
else process.env.FLOOM_CLOUD_MODE = previousCloud;
if (previousBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
else process.env.BETTER_AUTH_SECRET = previousBetterAuthSecret;

db.prepare(`UPDATE users SET is_admin = 1 WHERE id = 'local'`).run();
const badFilter = await call(adminRouter, 'GET', '/audit-log?target=not-a-target');
log('wrong filter params return 400', badFilter.status === 400, `got ${badFilter.status}`);

const filtered = await call(adminRouter, 'GET', `/audit-log?action=agent_token.minted&target=agent_token:${tokenId}`);
log(
  'admin endpoint with valid filter returns matching rows',
  filtered.status === 200 &&
    filtered.json?.audit_log?.length === 1 &&
    filtered.json.audit_log[0].target_id === tokenId,
  filtered.text,
);

const oneEntry = await call(adminRouter, 'GET', `/audit-log/${mintRow.id}`);
log('admin single-entry endpoint returns row', oneEntry.status === 200 && oneEntry.json?.entry?.id === mintRow.id);

// Edge cases ---------------------------------------------------------
const concurrentAppIds = Array.from({ length: 20 }, (_, i) => insertApp(`audit-concurrent-${i}`));
await Promise.all(
  concurrentAppIds.map(async (id) => {
    transitionVisibility(loadApp(id), 'link', {
      actorUserId: 'local',
      reason: 'owner_enable_link',
    });
  }),
);
const concurrentRows = db
  .prepare(
    `SELECT COUNT(*) AS c FROM audit_log
      WHERE action = 'app.visibility_changed'
        AND target_id LIKE 'app_%'`,
  )
  .get();
log('concurrent state changes write all rows without collision', concurrentRows.c >= 21, `got ${concurrentRows.c}`);

const empty = auditLog({
  actor: { userId: 'local' },
  action: 'test.empty_states',
  target: { type: 'app', id: visibilityAppId },
  before: null,
  after: null,
});
log('empty before/after states are valid', empty.before_state === null && empty.after_state === null);

const longMetadata = auditLog({
  actor: { userId: 'local' },
  action: 'test.long_metadata',
  target: { type: 'app', id: visibilityAppId },
  metadata: { payload: 'x'.repeat(10_000) },
});
log('very long metadata payload accepted', longMetadata.metadata?.payload?.length === 10_000);

const unicode = auditLog({
  actor: { userId: 'üser_测试', ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' },
  action: 'test.unicode_actor',
  target: { type: 'user', id: 'üser_测试' },
  metadata: { actor_name: 'Zoë 测试' },
});
log(
  'unicode actor ids and IPv6 addresses are accepted',
  unicode.actor_user_id === 'üser_测试' && unicode.actor_ip?.includes(':'),
);

const sweepLog = join(tmp, 'audit-sweep.log');
const sweepZero = sweepAuditLogRetention(sweepLog);
log('sweep with 0 old rows succeeds', sweepZero === 0, `deleted ${sweepZero}`);

const old = new Date(Date.now() - 370 * 24 * 60 * 60 * 1000).toISOString();
db.prepare(
  `INSERT INTO audit_log
     (id, actor_user_id, action, target_type, target_id, created_at)
   VALUES
     ('audit_old_non_admin', 'local', 'secret.updated', 'secret', 'old-secret', ?),
     ('audit_old_admin', 'local', 'admin.app_rejected', 'app', 'old-app', ?)`,
).run(old, old);
const sweepOne = sweepAuditLogRetention(sweepLog);
const oldNonAdmin = db.prepare(`SELECT id FROM audit_log WHERE id = 'audit_old_non_admin'`).get();
const oldAdmin = db.prepare(`SELECT id FROM audit_log WHERE id = 'audit_old_admin'`).get();
log('sweep deletes old non-admin rows', sweepOne === 1 && !oldNonAdmin, `deleted ${sweepOne}`);
log('sweep retains admin rows older than 1y', !!oldAdmin);

insertUser('audit_survivor', 'survivor@example.com', 'Survivor');
db.prepare(`INSERT INTO workspaces (id, slug, name, plan) VALUES ('ws_audit_survivor', 'ws-audit-survivor', 'Survivor', 'cloud_free')`).run();
db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_audit_survivor', 'audit_survivor', 'admin')`).run();
const survivorRow = auditLog({
  actor: { userId: 'audit_survivor' },
  action: 'test.before_user_delete',
  target: { type: 'user', id: 'audit_survivor' },
});
cleanupUserOrphans('audit_survivor');
const survivorRead = queryAuditLog({ actor_user_id: 'audit_survivor', limit: 20 });
log(
  'hard-delete user leaves their audit rows readable by admin',
  survivorRead.some((row) => row.id === survivorRow.id) &&
    survivorRead.some((row) => row.action === 'account.deleted'),
);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
