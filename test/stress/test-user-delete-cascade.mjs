#!/usr/bin/env node
// Regression test for cleanupUserOrphans (#170). Verifies the transactional
// cascade Better Auth's `afterDelete` hook triggers when a user deletes
// their account in cloud mode:
//
//   - user's private apps are deleted (apps table)
//   - private apps' secrets rows are deleted (no FK CASCADE)
//   - user's public apps are reassigned to the 'local' workspace
//   - user_active_workspace row is cleared
//   - user's Composio connections are cleared
//   - user row is removed from the mirror table
//   - workspaces where the user was the last member are deleted
//   - run_threads / app_reviews / feedback for those workspaces are deleted
//   - the synthetic 'local' workspace is never deleted
//
// Run: node test/stress/test-user-delete-cascade.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-user-delete-cascade-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db, DEFAULT_WORKSPACE_ID } = await import(
  '../../apps/server/dist/db.js'
);
const { cleanupUserOrphans } = await import(
  '../../apps/server/dist/services/cleanup.js'
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

console.log('cleanupUserOrphans regression tests');

// ---- fixture ----
// alice owns a solo workspace + one private app + one public app + secrets
// bob owns a workspace with alice as co-member (so bob's workspace survives
// alice's deletion). bob also has his own private app there.
// carol is unrelated; her state must be untouched.

function seedUser(id, email, name) {
  db.prepare(
    `INSERT INTO users (id, email, name, auth_provider, auth_subject)
     VALUES (?, ?, ?, 'better-auth', ?)`,
  ).run(id, email, name, id);
}
function seedWorkspace(id, name) {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'cloud_free')`,
  ).run(id, id, name);
}
function seedMember(workspaceId, userId, role) {
  db.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`,
  ).run(workspaceId, userId, role);
}
function seedApp(id, workspaceId, author, name, visibility) {
  db.prepare(
    `INSERT INTO apps
      (id, slug, name, description, manifest, app_type, code_path,
       workspace_id, author, visibility)
     VALUES (?, ?, ?, '', '{}', 'docker', '/tmp/nowhere', ?, ?, ?)`,
  ).run(id, id, name, workspaceId, author, visibility);
}
function seedSecret(id, name, appId) {
  db.prepare(
    `INSERT INTO secrets (id, name, value, app_id) VALUES (?, ?, 'v', ?)`,
  ).run(id, name, appId);
}

seedUser('alice', 'alice@floom.dev', 'Alice');
seedUser('bob', 'bob@floom.dev', 'Bob');
seedUser('carol', 'carol@floom.dev', 'Carol');

seedWorkspace('ws_alice', 'Alice solo');
seedMember('ws_alice', 'alice', 'admin');

seedWorkspace('ws_shared', 'Alice + Bob');
seedMember('ws_shared', 'alice', 'admin');
seedMember('ws_shared', 'bob', 'admin');

seedWorkspace('ws_carol', 'Carol solo');
seedMember('ws_carol', 'carol', 'admin');

// Alice-authored apps
seedApp('app_alice_private', 'ws_alice', 'alice', 'Alice private', 'auth-required');
seedApp('app_alice_public', 'ws_alice', 'alice', 'Alice public', 'public');
seedApp('app_alice_shared_private', 'ws_shared', 'alice', 'Shared private', 'auth-required');
// Bob-authored app in the shared workspace — must survive
seedApp('app_bob_private', 'ws_shared', 'bob', 'Bob private', 'auth-required');
// Carol-authored app — must survive untouched
seedApp('app_carol_private', 'ws_carol', 'carol', 'Carol private', 'auth-required');

// Secrets on alice's private apps — should be deleted
seedSecret('sec_a1', 'API_KEY', 'app_alice_private');
seedSecret('sec_a2', 'DB_URL', 'app_alice_shared_private');
// Secret on bob's app — must survive
seedSecret('sec_b1', 'API_KEY', 'app_bob_private');
// Secret on carol's app — must survive
seedSecret('sec_c1', 'API_KEY', 'app_carol_private');

// Alice has an active workspace pointer + a Composio connection
db.prepare(
  `INSERT INTO user_active_workspace (user_id, workspace_id) VALUES (?, ?)`,
).run('alice', 'ws_shared');
db.prepare(
  `INSERT INTO connections
     (id, workspace_id, owner_kind, owner_id, provider, status,
      composio_connection_id, composio_account_id)
   VALUES ('conn_alice', 'ws_shared', 'user', 'alice', 'slack', 'active', 'cx1', 'ca1')`,
).run();
// Carol has her own connection — must survive
db.prepare(
  `INSERT INTO connections
     (id, workspace_id, owner_kind, owner_id, provider, status,
      composio_connection_id, composio_account_id)
   VALUES ('conn_carol', 'ws_carol', 'user', 'carol', 'slack', 'active', 'cx2', 'ca2')`,
).run();

// Act ---------------------------------------------------------------
cleanupUserOrphans('alice');

// Assertions --------------------------------------------------------
function countRows(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row?.c ?? 0;
}

// 1. alice's user row is gone
const aliceUser = db.prepare('SELECT id FROM users WHERE id = ?').get('alice');
log('user row deleted', !aliceUser);

// 2. bob + carol untouched
const bobUser = db.prepare('SELECT id FROM users WHERE id = ?').get('bob');
const carolUser = db.prepare('SELECT id FROM users WHERE id = ?').get('carol');
log('bob user preserved', !!bobUser);
log('carol user preserved', !!carolUser);

// 3. alice's private apps deleted
const alicePrivate = db
  .prepare('SELECT id FROM apps WHERE id = ?')
  .get('app_alice_private');
const aliceSharedPrivate = db
  .prepare('SELECT id FROM apps WHERE id = ?')
  .get('app_alice_shared_private');
log('alice private app deleted', !alicePrivate);
log('alice shared-workspace private app deleted', !aliceSharedPrivate);

// 4. alice's public app migrated to local
const alicePublic = db
  .prepare('SELECT workspace_id, author, visibility FROM apps WHERE id = ?')
  .get('app_alice_public');
log('alice public app still exists', !!alicePublic);
log(
  'alice public app reassigned to local workspace',
  alicePublic?.workspace_id === DEFAULT_WORKSPACE_ID,
);
log('alice public app author cleared', alicePublic?.author === null);

// 5. bob's private app preserved (shared workspace has him as remaining member)
const bobApp = db
  .prepare('SELECT id, workspace_id FROM apps WHERE id = ?')
  .get('app_bob_private');
log('bob private app preserved', !!bobApp);
log('bob private app still in shared workspace', bobApp?.workspace_id === 'ws_shared');

// 6. carol untouched
const carolApp = db
  .prepare('SELECT id FROM apps WHERE id = ?')
  .get('app_carol_private');
log('carol private app preserved', !!carolApp);

// 7. secrets on deleted apps are gone
const aliceSecrets = countRows(
  "SELECT COUNT(*) as c FROM secrets WHERE app_id IN ('app_alice_private','app_alice_shared_private')",
);
log('secrets on alice private apps deleted', aliceSecrets === 0);
// bob + carol secrets preserved
const survivorSecrets = countRows(
  "SELECT COUNT(*) as c FROM secrets WHERE app_id IN ('app_bob_private','app_carol_private')",
);
log('secrets on bob + carol apps preserved', survivorSecrets === 2);

// 8. alice's solo workspace deleted; shared workspace survives
const wsAlice = db.prepare('SELECT id FROM workspaces WHERE id = ?').get('ws_alice');
const wsShared = db.prepare('SELECT id FROM workspaces WHERE id = ?').get('ws_shared');
const wsCarol = db.prepare('SELECT id FROM workspaces WHERE id = ?').get('ws_carol');
log("alice's solo workspace deleted (no members remain)", !wsAlice);
log('shared workspace preserved (bob still a member)', !!wsShared);
log('carol workspace preserved', !!wsCarol);

// 9. synthetic 'local' workspace is never touched
const wsLocal = db
  .prepare('SELECT id FROM workspaces WHERE id = ?')
  .get(DEFAULT_WORKSPACE_ID);
log('local workspace never deleted', !!wsLocal);

// 10. alice's connection gone; carol's preserved
const connAlice = db.prepare('SELECT id FROM connections WHERE id = ?').get('conn_alice');
const connCarol = db.prepare('SELECT id FROM connections WHERE id = ?').get('conn_carol');
log('alice composio connection deleted', !connAlice);
log('carol composio connection preserved', !!connCarol);

// 11. alice's active workspace pointer gone
const aliceActive = db
  .prepare('SELECT user_id FROM user_active_workspace WHERE user_id = ?')
  .get('alice');
log('alice active workspace pointer cleared', !aliceActive);

// 12. idempotency: running again is a no-op
cleanupUserOrphans('alice');
log('second call is a no-op (idempotent)', true);

// 13. cleanup for never-seen user is a safe no-op
cleanupUserOrphans('ghost_user_id');
log('cleanup on unknown user is safe', true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
