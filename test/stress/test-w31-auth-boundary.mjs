#!/usr/bin/env node
// W3.1 auth boundary tests. The single most important test in the W3.1
// surface per TEST-PROTOCOL.md section 5a:
//
//   "Seed user A and user B. Assert: user A cannot read user B's
//    app memory / runs / tickets / reviews / api keys / connections via
//    any endpoint."
//
// We build the SessionContext directly (bypassing Better Auth) for both
// users, then exercise every read path to confirm Floom never leaks one
// user's data through another user's context. We test the SERVICE LAYER
// because that's where the workspace_id + user_id predicates live; the
// HTTP routes are thin wrappers and tested separately.
//
// Surfaces under test:
//   1. app_memory.get / list / set / del — never sees another user's keys
//   2. user_secrets.get / listMasked / set / del — never sees another user
//   3. connections.listConnections — never sees another user's connections
//   4. workspaces.listMine / getById / listMembers — workspace boundary
//   5. workspaces.me() — composed payload only shows caller's data
//
// In addition to the same-workspace cross-user case, we also test the
// cross-workspace case (user from workspace A cannot peek into workspace B).
//
// Run: node test/stress/test-w31-auth-boundary.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w31-bnd-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db, DEFAULT_WORKSPACE_ID } = await import(
  '../../apps/server/dist/db.js'
);
const ws = await import('../../apps/server/dist/services/workspaces.js');
const appMemory = await import(
  '../../apps/server/dist/services/app_memory.js'
);
const userSecrets = await import(
  '../../apps/server/dist/services/user_secrets.js'
);
const composio = await import('../../apps/server/dist/services/composio.js');

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

console.log('W3.1 auth boundary tests');

// ---- helpers ----
function seedUser(id, email, name) {
  db.prepare(
    `INSERT INTO users (id, email, name, auth_provider, auth_subject)
     VALUES (?, ?, ?, 'better-auth', ?)`,
  ).run(id, email, name, id);
}

function buildCtx(user_id, workspace_id) {
  return {
    workspace_id,
    user_id,
    device_id: `dev-${user_id}`,
    is_authenticated: true,
    auth_user_id: user_id,
    email: `${user_id}@floom.dev`,
  };
}

// ---- seed two users in the same workspace ----
seedUser('alice', 'alice@floom.dev', 'Alice');
seedUser('bob', 'bob@floom.dev', 'Bob');
seedUser('eve', 'eve@floom.dev', 'Eve');

// alice creates a workspace, bob is added as editor, eve is in a different ws
const aliceCtx0 = buildCtx('alice', DEFAULT_WORKSPACE_ID);
const aliceWs = ws.create(aliceCtx0, { name: 'Alice Co' });
db.prepare(
  `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'editor')`,
).run(aliceWs.id, 'bob');

const eveCtx0 = buildCtx('eve', DEFAULT_WORKSPACE_ID);
const eveWs = ws.create(eveCtx0, { name: 'Eve Inc' });

// Build the per-user contexts
const aliceCtx = buildCtx('alice', aliceWs.id);
const bobCtx = buildCtx('bob', aliceWs.id);
const eveCtx = buildCtx('eve', eveWs.id);

// ---- seed an app + per-user app_memory rows ----
const manifest = {
  name: 'TestApp',
  description: 'x',
  actions: { run: { label: 'r', inputs: [], outputs: [] } },
  runtime: 'python',
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
  manifest_version: '2.0',
  memory_keys: ['notes'],
};
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, workspace_id, memory_keys)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  'app_test',
  'testapp',
  'TestApp',
  'x',
  JSON.stringify(manifest),
  'proxied:testapp',
  aliceWs.id,
  JSON.stringify(['notes']),
);

// alice writes a memory row in alice's workspace
await appMemory.set(aliceCtx, 'testapp', 'notes', { secret: 'alice-data' });
// bob writes one too (same app, same workspace, different user)
await appMemory.set(bobCtx, 'testapp', 'notes', { secret: 'bob-data' });

// also seed an app in eve's workspace so cross-workspace reads have data
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, workspace_id, memory_keys)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  'app_eve',
  'eveapp',
  'EveApp',
  'x',
  JSON.stringify({ ...manifest, name: 'EveApp' }),
  'proxied:eveapp',
  eveWs.id,
  JSON.stringify(['notes']),
);
await appMemory.set(eveCtx, 'eveapp', 'notes', { secret: 'eve-data' });

// =====================================================================
// Test 1: app_memory boundary
// =====================================================================
console.log('\n[1] app_memory boundary');

// 1a. alice reads her own row
let aliceRow = await appMemory.get(aliceCtx, 'testapp', 'notes');
log('alice can read her own memory key', aliceRow?.secret === 'alice-data');

// 1b. bob reads his own row (in same workspace)
let bobRow = await appMemory.get(bobCtx, 'testapp', 'notes');
log('bob can read his own memory key', bobRow?.secret === 'bob-data');

// 1c. listing alice's memory returns ONLY alice's value
const aliceList = await appMemory.list(aliceCtx, 'testapp');
log(
  "alice's list returns alice-data (not bob-data)",
  aliceList?.notes?.secret === 'alice-data',
);
log(
  "alice's list does NOT contain bob-data",
  !JSON.stringify(aliceList).includes('bob-data'),
);

// 1d. bob's list returns ONLY bob's value
const bobList = await appMemory.list(bobCtx, 'testapp');
log(
  "bob's list returns bob-data (not alice-data)",
  bobList?.notes?.secret === 'bob-data',
);
log(
  "bob's list does NOT contain alice-data",
  !JSON.stringify(bobList).includes('alice-data'),
);

// 1e. eve (different workspace entirely) sees nothing on alice's app
const eveListAlice = await appMemory.list(eveCtx, 'testapp');
log(
  'eve cannot list alice-workspace app from her own workspace context',
  Object.keys(eveListAlice).length === 0,
);
const eveGetAlice = await appMemory.get(eveCtx, 'testapp', 'notes');
log(
  'eve.get on alice-workspace app returns null (cross-workspace boundary)',
  eveGetAlice === null || eveGetAlice === undefined,
);

// 1f. eve reads her own
const eveOwn = await appMemory.get(eveCtx, 'eveapp', 'notes');
log('eve can read her own', eveOwn?.secret === 'eve-data');

// 1g. alice tries to delete bob's key — del returns 0 (no row affected)
const delAttempt = await appMemory.del(aliceCtx, 'testapp', 'notes');
log('alice.del removes only her own row', delAttempt === 1 || delAttempt === true);
// confirm bob's row still there
const bobStillThere = await appMemory.get(bobCtx, 'testapp', 'notes');
log('bob row still intact after alice.del', bobStillThere?.secret === 'bob-data');

// =====================================================================
// Test 2: user_secrets boundary
// =====================================================================
console.log('\n[2] user_secrets boundary');

// alice puts a secret
userSecrets.set(aliceCtx, 'OPENAI_KEY', 'sk-alice-secret-12345');
// bob puts a different secret with the same key name
userSecrets.set(bobCtx, 'OPENAI_KEY', 'sk-bob-secret-67890');

// alice reads her own
const aliceSecret = userSecrets.get(aliceCtx, 'OPENAI_KEY');
log('alice reads her own secret', aliceSecret === 'sk-alice-secret-12345');

// bob reads his own
const bobSecret = userSecrets.get(bobCtx, 'OPENAI_KEY');
log('bob reads his own secret', bobSecret === 'sk-bob-secret-67890');

// alice's masked list does NOT contain bob's value
const aliceMasked = userSecrets.listMasked(aliceCtx);
log(
  'alice listMasked: 1 entry (own only)',
  aliceMasked.length === 1 && aliceMasked[0].key === 'OPENAI_KEY',
);
log(
  'alice listMasked: never returns plaintext',
  !JSON.stringify(aliceMasked).includes('sk-alice-secret-12345') &&
    !JSON.stringify(aliceMasked).includes('sk-bob-secret-67890'),
);

// bob's masked list also 1 entry
const bobMasked = userSecrets.listMasked(bobCtx);
log(
  'bob listMasked: 1 entry (own only)',
  bobMasked.length === 1 && bobMasked[0].key === 'OPENAI_KEY',
);

// eve sees nothing
const eveMasked = userSecrets.listMasked(eveCtx);
log('eve listMasked: 0 entries', eveMasked.length === 0);
const eveSecret = userSecrets.get(eveCtx, 'OPENAI_KEY');
log('eve cannot read alice/bob secret', eveSecret === null || eveSecret === undefined);

// alice.del on her own key
const delS = userSecrets.del(aliceCtx, 'OPENAI_KEY');
log('alice.del removed her secret', delS === 1 || delS === true);
// bob's still there
const bobAfter = userSecrets.get(bobCtx, 'OPENAI_KEY');
log('bob secret intact after alice.del', bobAfter === 'sk-bob-secret-67890');

// =====================================================================
// Test 3: connections boundary
// =====================================================================
console.log('\n[3] connections boundary');

// Seed 2 connections with raw SQL (bypass the Composio SDK).
db.prepare(
  `INSERT INTO connections
     (id, workspace_id, owner_kind, owner_id, provider,
      composio_connection_id, composio_account_id, status)
   VALUES (?, ?, 'user', ?, ?, ?, ?, 'active')`,
).run('con_alice_g', aliceWs.id, 'alice', 'gmail', 'comp_a_g', 'user:alice');
db.prepare(
  `INSERT INTO connections
     (id, workspace_id, owner_kind, owner_id, provider,
      composio_connection_id, composio_account_id, status)
   VALUES (?, ?, 'user', ?, ?, ?, ?, 'active')`,
).run('con_bob_g', aliceWs.id, 'bob', 'gmail', 'comp_b_g', 'user:bob');
db.prepare(
  `INSERT INTO connections
     (id, workspace_id, owner_kind, owner_id, provider,
      composio_connection_id, composio_account_id, status)
   VALUES (?, ?, 'user', ?, ?, ?, ?, 'active')`,
).run('con_eve_n', eveWs.id, 'eve', 'notion', 'comp_e_n', 'user:eve');

const aliceConns = await composio.listConnections(aliceCtx);
log('alice connections: 1 row', aliceConns.length === 1);
log(
  'alice connections: only own gmail',
  aliceConns[0]?.composio_connection_id === 'comp_a_g',
);

const bobConns = await composio.listConnections(bobCtx);
log('bob connections: 1 row', bobConns.length === 1);
log(
  'bob connections: only own gmail',
  bobConns[0]?.composio_connection_id === 'comp_b_g',
);

const eveConns = await composio.listConnections(eveCtx);
log('eve connections: 1 row (own ws only)', eveConns.length === 1);
log(
  'eve connections: notion in eve-ws',
  eveConns[0]?.composio_connection_id === 'comp_e_n',
);

// Cross-context read attempt: alice with eve's workspace_id (forged ctx).
// This simulates an attacker who guesses the workspace id but has alice's
// auth. The query should still scope by user_id so alice gets nothing.
const aliceWithEveWs = { ...aliceCtx, workspace_id: eveWs.id };
const aliceForged = await composio.listConnections(aliceWithEveWs);
log(
  'alice with forged workspace_id sees no rows (predicate joins user+ws)',
  aliceForged.length === 0,
);

// =====================================================================
// Test 4: workspaces.listMine / getById / listMembers boundary
// =====================================================================
console.log('\n[4] workspaces boundary');

// alice's listMine doesn't include eve's workspace
const aliceWorkspaces = ws.listMine(aliceCtx).map((m) => m.workspace.id);
log(
  "alice's workspaces don't include eve's workspace",
  !aliceWorkspaces.includes(eveWs.id),
);
log(
  "alice's workspaces include alice's own",
  aliceWorkspaces.includes(aliceWs.id),
);

// alice cannot getById eve's workspace
let threw = null;
try {
  ws.getById(aliceCtx, eveWs.id);
} catch (err) {
  threw = err.name;
}
log('alice cannot getById eve-workspace', threw === 'NotAMemberError');

// alice cannot list eve-workspace members
threw = null;
try {
  ws.listMembers(aliceCtx, eveWs.id);
} catch (err) {
  threw = err.name;
}
log('alice cannot list eve-workspace members', threw === 'NotAMemberError');

// alice cannot patch eve-workspace
threw = null;
try {
  ws.update(aliceCtx, eveWs.id, { name: 'pwned' });
} catch (err) {
  threw = err.name;
}
log('alice cannot patch eve-workspace', threw === 'NotAMemberError');

// alice cannot delete eve-workspace
threw = null;
try {
  ws.remove(aliceCtx, eveWs.id);
} catch (err) {
  threw = err.name;
}
log('alice cannot delete eve-workspace', threw === 'NotAMemberError');

// alice cannot invite into eve-workspace
threw = null;
try {
  ws.inviteByEmail(aliceCtx, eveWs.id, 'mallory@evil.com');
} catch (err) {
  threw = err.name;
}
log('alice cannot invite into eve-workspace', threw === 'NotAMemberError');

// alice cannot revoke an eve-workspace invite
threw = null;
try {
  ws.revokeInvite(aliceCtx, eveWs.id, 'inv_doesnt_matter');
} catch (err) {
  threw = err.name;
}
log('alice cannot revoke eve-workspace invite', threw === 'NotAMemberError');

// alice cannot list eve-workspace invites
threw = null;
try {
  ws.listInvites(aliceCtx, eveWs.id);
} catch (err) {
  threw = err.name;
}
log('alice cannot list eve-workspace invites', threw === 'NotAMemberError');

// alice cannot change roles in eve-workspace
threw = null;
try {
  ws.changeRole(aliceCtx, eveWs.id, 'eve', 'viewer');
} catch (err) {
  threw = err.name;
}
log('alice cannot demote eve in eve-workspace', threw === 'NotAMemberError');

// alice cannot remove eve from eve-workspace
threw = null;
try {
  ws.removeMember(aliceCtx, eveWs.id, 'eve');
} catch (err) {
  threw = err.name;
}
log('alice cannot remove eve from eve-workspace', threw === 'NotAMemberError');

// =====================================================================
// Test 5: me() composed payload boundary
// =====================================================================
console.log('\n[5] me() boundary');

const aliceMe = ws.me(aliceCtx, true);
const aliceMeWsIds = aliceMe.workspaces.map((w) => w.id);
log(
  'alice me.workspaces does not include eve-workspace',
  !aliceMeWsIds.includes(eveWs.id),
);
log(
  'alice me.user.id=alice (not bob, not eve)',
  aliceMe.user.id === 'alice',
);
log(
  'alice me.user.email=alice@floom.dev',
  aliceMe.user.email === 'alice@floom.dev',
);

const eveMe = ws.me(eveCtx, true);
log(
  'eve me.workspaces does not include alice-workspace',
  !eveMe.workspaces.map((w) => w.id).includes(aliceWs.id),
);
log('eve me.user.id=eve', eveMe.user.id === 'eve');

// =====================================================================
// cleanup
// =====================================================================
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
