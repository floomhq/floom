#!/usr/bin/env node
// W2.3 composio service tests. Exercises services/composio.ts with a
// fully in-memory fake client injected via setComposioClient. Covers:
//
//   - resolveAuthConfigId: env-driven, missing env → ComposioConfigError
//   - buildComposioUserId: device: / user: prefix
//   - contextOwner: device pre-auth, user post-auth
//   - initiateConnection: persists pending row, returns auth_url
//   - finishConnection: polls fake, flips to active, persists metadata
//   - listConnections: scoped to caller
//   - getConnection: by provider
//   - revokeConnection: calls delete, flips local row, idempotent
//   - executeAction: requires active connection, passes composio user id
//   - cross-tenant isolation
//   - config errors (missing COMPOSIO_AUTH_CONFIG_*) return cleanly
//
// Run: node test/stress/test-w23-composio-service.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w23-svc-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.COMPOSIO_AUTH_CONFIG_GMAIL = 'ac_gmail_test';
process.env.COMPOSIO_AUTH_CONFIG_NOTION = 'ac_notion_test';
// Intentionally leave COMPOSIO_AUTH_CONFIG_SLACK unset to test the missing-env path.

const { db, DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID } = await import(
  '../../apps/server/dist/db.js'
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

console.log('W2.3 composio service tests');

// ---- in-memory fake Composio client ----
function makeFakeClient() {
  const state = {
    accounts: new Map(), // id → { id, status, userId, toolkit, data }
    initiateCalls: [],
    deleteCalls: [],
    executeCalls: [],
    nextId: 1,
  };
  const client = {
    connectedAccounts: {
      async initiate(userId, authConfigId, options) {
        state.initiateCalls.push({ userId, authConfigId, options });
        const id = `fake_conn_${state.nextId++}`;
        state.accounts.set(id, {
          id,
          status: 'INITIATED',
          userId,
          authConfigId,
          toolkit: { slug: authConfigId.replace('ac_', '').replace('_test', '') },
          data: { email: `${userId.replace(/[^a-z0-9]/gi, '')}@example.com` },
        });
        return {
          id,
          status: 'INITIATED',
          redirectUrl: `https://composio.dev/oauth/${id}?cb=${encodeURIComponent(options?.callbackUrl || '')}`,
        };
      },
      async get(id) {
        const acc = state.accounts.get(id);
        if (!acc) throw new Error(`fake: account ${id} not found`);
        // Auto-flip to ACTIVE the first time we poll, mimicking Composio's
        // behavior after a successful consent.
        if (acc.status === 'INITIATED') acc.status = 'ACTIVE';
        return { id, status: acc.status, toolkit: acc.toolkit, data: acc.data };
      },
      async delete(id) {
        state.deleteCalls.push(id);
        if (!state.accounts.has(id)) {
          const err = new Error('fake: 404 not found');
          throw err;
        }
        state.accounts.delete(id);
        return { success: true, id };
      },
    },
    tools: {
      async execute(slug, body) {
        state.executeCalls.push({ slug, body });
        return {
          data: { echoed: body.arguments || {}, as: body.userId, tool: slug },
          successful: true,
          error: null,
        };
      },
    },
  };
  return { client, state };
}

const { client, state } = makeFakeClient();
composio.setComposioClient(client);

// ---- 1. resolveAuthConfigId ----
log(
  'resolveAuthConfigId: gmail → env value',
  composio.resolveAuthConfigId('gmail') === 'ac_gmail_test',
);
log(
  'resolveAuthConfigId: notion → env value',
  composio.resolveAuthConfigId('notion') === 'ac_notion_test',
);
let configMissingErr = false;
try {
  composio.resolveAuthConfigId('slack');
} catch (err) {
  configMissingErr =
    err.name === 'ComposioConfigError' &&
    /COMPOSIO_AUTH_CONFIG_SLACK/.test(err.message);
}
log('resolveAuthConfigId: missing env → ComposioConfigError', configMissingErr);

let emptyProviderErr = false;
try {
  composio.resolveAuthConfigId('');
} catch (err) {
  emptyProviderErr = err.name === 'ComposioConfigError';
}
log('resolveAuthConfigId: empty provider → ComposioConfigError', emptyProviderErr);

// ---- 2. buildComposioUserId ----
log(
  'buildComposioUserId: device prefix',
  composio.buildComposioUserId('device', 'abc-123') === 'device:abc-123',
);
log(
  'buildComposioUserId: user prefix',
  composio.buildComposioUserId('user', 'u_42') === 'user:u_42',
);
let bcidErr = false;
try {
  composio.buildComposioUserId('admin', 'xyz');
} catch (err) {
  bcidErr = err.name === 'ComposioConfigError';
}
log('buildComposioUserId: invalid owner_kind rejected', bcidErr);

// ---- 3. contextOwner ----
const deviceCtx = {
  workspace_id: DEFAULT_WORKSPACE_ID,
  user_id: DEFAULT_USER_ID,
  device_id: 'dev-123',
  is_authenticated: false,
};
const userCtx = {
  workspace_id: DEFAULT_WORKSPACE_ID,
  user_id: 'alice',
  device_id: 'dev-alice',
  is_authenticated: true,
};
const devOwner = composio.contextOwner(deviceCtx);
log(
  'contextOwner(deviceCtx): device/dev-123',
  devOwner.owner_kind === 'device' && devOwner.owner_id === 'dev-123',
);
const userOwner = composio.contextOwner(userCtx);
log(
  'contextOwner(userCtx): user/alice',
  userOwner.owner_kind === 'user' && userOwner.owner_id === 'alice',
);

// ---- 4. initiateConnection (device) ----
const init1 = await composio.initiateConnection(
  deviceCtx,
  'gmail',
  'https://floom.dev/api/connections/callback',
);
log('initiate: returns auth_url', !!init1.auth_url && init1.auth_url.startsWith('https://composio.dev/'));
log('initiate: returns connection_id', typeof init1.connection_id === 'string' && init1.connection_id.length > 0);
log('initiate: provider echoed', init1.provider === 'gmail');
log('initiate: expires_at is ISO', !!Date.parse(init1.expires_at));

// Composio fake should have been called with the right shape
const lastInit = state.initiateCalls[state.initiateCalls.length - 1];
log('initiate: Composio called with device: userId', lastInit.userId === 'device:dev-123');
log('initiate: Composio called with gmail authConfigId', lastInit.authConfigId === 'ac_gmail_test');
log(
  'initiate: callbackUrl passed through',
  lastInit.options?.callbackUrl === 'https://floom.dev/api/connections/callback',
);

// DB row should be persisted in 'pending' state
const row = db
  .prepare(
    `SELECT * FROM connections WHERE workspace_id = ? AND owner_kind = ? AND owner_id = ? AND provider = ?`,
  )
  .get(DEFAULT_WORKSPACE_ID, 'device', 'dev-123', 'gmail');
log('initiate: DB row persisted', !!row);
log('initiate: status = pending', row && row.status === 'pending');
log('initiate: composio_account_id = device:dev-123', row && row.composio_account_id === 'device:dev-123');

// ---- 5. initiate with missing env → bubbles up ComposioConfigError ----
let missingEnvErr = false;
try {
  await composio.initiateConnection(deviceCtx, 'slack');
} catch (err) {
  missingEnvErr = err.name === 'ComposioConfigError';
}
log('initiate(slack): ComposioConfigError', missingEnvErr);

// ---- 6. finishConnection flips to active ----
const finished = await composio.finishConnection(deviceCtx, init1.connection_id);
log('finish: status=active', finished.status === 'active');
log('finish: metadata has account_email', finished.metadata_json && /account_email/.test(finished.metadata_json));

// DB row should be updated, not duplicated
const postRows = db
  .prepare(`SELECT COUNT(*) as n FROM connections WHERE owner_id = ? AND provider = ?`)
  .get('dev-123', 'gmail').n;
log('finish: single row after upsert', postRows === 1);

// ---- 7. finish with wrong owner → ConnectionNotFoundError ----
let notFoundErr = false;
try {
  const otherCtx = { ...deviceCtx, device_id: 'different-device' };
  await composio.finishConnection(otherCtx, init1.connection_id);
} catch (err) {
  notFoundErr = err.name === 'ConnectionNotFoundError';
}
log('finish: cross-owner attempt → ConnectionNotFoundError', notFoundErr);

// ---- 8. listConnections: scoped to caller ----
const list1 = await composio.listConnections(deviceCtx);
log('list(device): 1 connection', list1.length === 1);
log('list(device): gmail', list1[0].provider === 'gmail' && list1[0].status === 'active');

// Connect notion for same device
const init2 = await composio.initiateConnection(deviceCtx, 'notion');
await composio.finishConnection(deviceCtx, init2.connection_id);
const list2 = await composio.listConnections(deviceCtx);
log('list(device): 2 connections', list2.length === 2);

// Status filter
const onlyActive = await composio.listConnections(deviceCtx, { status: 'active' });
log('list(device, active): 2 rows', onlyActive.length === 2);
const onlyPending = await composio.listConnections(deviceCtx, { status: 'pending' });
log('list(device, pending): 0 rows', onlyPending.length === 0);

// Different device → empty list
const otherCtx2 = { ...deviceCtx, device_id: 'dev-other' };
const otherList = await composio.listConnections(otherCtx2);
log('list(other device): isolated (0 rows)', otherList.length === 0);

// ---- 9. getConnection by provider ----
const got = await composio.getConnection(deviceCtx, 'gmail');
log('getConnection: returns the gmail row', got && got.provider === 'gmail');
const notExist = await composio.getConnection(deviceCtx, 'stripe');
log('getConnection: unknown → null', notExist === null);

// ---- 10. executeAction ----
const result = await composio.executeAction(deviceCtx, 'gmail', 'GMAIL_SEND_EMAIL', {
  to: 'foo@bar.com',
  subject: 'test',
});
log('execute: returns successful=true', result.successful === true);
log(
  'execute: Composio called with correct userId',
  state.executeCalls.length === 1 &&
    state.executeCalls[0].body.userId === 'device:dev-123',
);
log(
  'execute: arguments forwarded',
  state.executeCalls[0].body.arguments?.to === 'foo@bar.com',
);
log(
  'execute: tool slug forwarded',
  state.executeCalls[0].slug === 'GMAIL_SEND_EMAIL',
);

// ---- 11. executeAction with no active connection → error ----
let noActiveErr = false;
try {
  await composio.executeAction(otherCtx2, 'gmail', 'GMAIL_SEND_EMAIL', {});
} catch (err) {
  noActiveErr = err.name === 'ConnectionNotFoundError';
}
log('execute: no active connection → ConnectionNotFoundError', noActiveErr);

// ---- 12. revokeConnection: calls delete, flips to revoked ----
const revoked = await composio.revokeConnection(deviceCtx, 'notion');
log('revoke: status=revoked', revoked && revoked.status === 'revoked');
log('revoke: Composio delete called', state.deleteCalls.includes(init2.connection_id));

// ---- 13. revoke idempotent: second call returns the revoked row ----
const revoked2 = await composio.revokeConnection(deviceCtx, 'notion');
log(
  'revoke: idempotent (second call returns revoked row, no new delete)',
  revoked2 && revoked2.status === 'revoked' && state.deleteCalls.length === 1,
);

// ---- 14. revoke unknown → null ----
const revokeUnknown = await composio.revokeConnection(deviceCtx, 'airtable');
log('revoke: unknown provider → null', revokeUnknown === null);

// ---- 15. revoke swallows upstream 404 ----
// Manually delete the row from the fake then try revoking from floom.
state.accounts.delete(init1.connection_id); // the gmail account
const revokeGone = await composio.revokeConnection(deviceCtx, 'gmail');
log('revoke: upstream 404 swallowed, local flipped', revokeGone && revokeGone.status === 'revoked');

// ---- 16. user-owned flow (simulate post-W3.1 call) ----
// Insert alice as a real user so FKs are OK
db.prepare(
  `INSERT OR IGNORE INTO users (id, workspace_id, auth_provider) VALUES (?, ?, 'google')`,
).run('alice', DEFAULT_WORKSPACE_ID);

const initA = await composio.initiateConnection(userCtx, 'gmail');
log('user flow: initiate works', !!initA.auth_url);
const lastCall = state.initiateCalls[state.initiateCalls.length - 1];
log('user flow: Composio called with user: prefix', lastCall.userId === 'user:alice');

await composio.finishConnection(userCtx, initA.connection_id);
const aliceList = await composio.listConnections(userCtx);
log('user flow: alice owns 1 connection', aliceList.length === 1);

// Device list still isolated
const deviceListAfter = await composio.listConnections(deviceCtx);
log(
  'user flow: device list not polluted by alice',
  deviceListAfter.every((c) => c.owner_kind === 'device'),
);

// ---- 17. cross-workspace isolation ----
// Insert a second workspace + a device row under it, verify device-1
// can't see it.
db.prepare(
  `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'oss')`,
).run('ws-other', 'ws-other', 'Other');
db.prepare(
  `INSERT INTO connections
     (id, workspace_id, owner_kind, owner_id, provider,
      composio_connection_id, composio_account_id, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
).run(
  'con_otherws',
  'ws-other',
  'device',
  'dev-123', // same device id, different workspace
  'gmail',
  'comp_x',
  'device:dev-123',
);
const homeList = await composio.listConnections(deviceCtx);
const foreign = homeList.find((c) => c.workspace_id === 'ws-other');
log('cross-workspace isolation: no foreign rows leaked', !foreign);

// ---- cleanup ----
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
