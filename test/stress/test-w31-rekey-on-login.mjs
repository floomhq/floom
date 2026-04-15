#!/usr/bin/env node
// W3.1 rekey-on-login tests. Validates the integration between
// services/session.ts and the rekey flow when a user authenticates for the
// first time via Better Auth. The W2.1 + W2.3 tests already cover the
// pure rekeyDevice() function — this file specifically covers the
// "first authenticated request" plumbing:
//
//   - bootstrapPersonalWorkspace creates a workspace named after the email
//   - The active workspace pointer is set
//   - rekeyDevice runs once and migrates app_memory, runs, threads, conns
//   - A second auth'd request is a no-op (idempotent)
//   - users.composio_user_id is populated on first rekey only
//   - SessionContext.is_authenticated=true is propagated
//
// Better Auth itself is NOT booted (we'd need email+social config). We
// inject a fake getSession via monkey-patching the singleton, then call
// resolveUserContext directly with a Hono-shaped context.
//
// Run: node test/stress/test-w31-rekey-on-login.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w31-rekey-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.BETTER_AUTH_URL = 'http://localhost:3051';

const { db, DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID } = await import(
  '../../apps/server/dist/db.js'
);
const session = await import('../../apps/server/dist/services/session.js');
const auth = await import('../../apps/server/dist/lib/better-auth.js');

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

console.log('W3.1 rekey-on-login tests');

// ---- 1. Boot the auth instance and monkey-patch getSession ----
auth._resetAuthForTests();
const a = auth.getAuth();
log('cloud mode getAuth() returns instance', a !== null);

// Replace getSession with our fake. The real Better Auth would walk
// sessions / accounts / verifications; we just return a synthetic user.
let fakeUser = null;
a.api.getSession = async () => {
  if (!fakeUser) return null;
  return {
    user: fakeUser,
    session: { id: 'sess_fake' },
  };
};

// ---- 2. helper to build a Hono-shaped context ----
function buildHonoCtx(deviceCookie) {
  const headers = new Map();
  if (deviceCookie) headers.set('cookie', `floom_device=${deviceCookie}`);
  const responseHeaders = [];
  return {
    req: {
      header: (n) => headers.get(n.toLowerCase()) || null,
      raw: { headers: new Headers() },
    },
    header: (k, v) => responseHeaders.push([k, v]),
    _responseHeaders: responseHeaders,
  };
}

// ---- 3. Anonymous request → OSS-style ctx, even in cloud mode ----
const c1 = buildHonoCtx('dev-anon-99');
const ctx1 = await session.resolveUserContext(c1);
log('cloud + no Better Auth session → device-only ctx', ctx1.is_authenticated === false);
log('cloud + no session: workspace_id=local', ctx1.workspace_id === DEFAULT_WORKSPACE_ID);
log('cloud + no session: user_id=local', ctx1.user_id === DEFAULT_USER_ID);

// ---- 4. Seed pre-login data tied to dev-anon-99 ----
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, workspace_id, memory_keys)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  'app_rk_login',
  'rk-login',
  'Rk',
  'x',
  JSON.stringify({
    name: 'Rk',
    description: 'x',
    actions: { run: { label: 'r', inputs: [], outputs: [] } },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '2.0',
    memory_keys: ['k'],
  }),
  'proxied:rk',
  DEFAULT_WORKSPACE_ID,
  JSON.stringify(['k']),
);
db.prepare(
  `INSERT INTO app_memory (workspace_id, app_slug, user_id, device_id, key, value)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run(
  DEFAULT_WORKSPACE_ID,
  'rk-login',
  DEFAULT_USER_ID,
  'dev-anon-99',
  'k',
  '"pre-login"',
);
db.prepare(
  `INSERT INTO runs (id, app_id, action, inputs, status, workspace_id, user_id, device_id)
   VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?)`,
).run('run_rk_login', 'app_rk_login', 'r', '{}', DEFAULT_WORKSPACE_ID, 'dev-anon-99');
db.prepare(
  `INSERT INTO run_threads (id, workspace_id, user_id, device_id) VALUES (?, ?, NULL, ?)`,
).run('thr_rk_login', DEFAULT_WORKSPACE_ID, 'dev-anon-99');
db.prepare(
  `INSERT INTO connections
     (id, workspace_id, owner_kind, owner_id, provider,
      composio_connection_id, composio_account_id, status)
   VALUES (?, ?, 'device', ?, ?, ?, ?, 'active')`,
).run(
  'con_rk_login',
  DEFAULT_WORKSPACE_ID,
  'dev-anon-99',
  'gmail',
  'comp_rk_login',
  'device:dev-anon-99',
);

// ---- 5. First authenticated request: fakeUser logs in ----
fakeUser = {
  id: 'usr_zara',
  email: 'zara@floom.dev',
  name: 'Zara',
};
const c2 = buildHonoCtx('dev-anon-99');
const ctx2 = await session.resolveUserContext(c2);
log('first auth request: is_authenticated=true', ctx2.is_authenticated === true);
log('first auth request: user_id=usr_zara', ctx2.user_id === 'usr_zara');
log('first auth request: email=zara@floom.dev', ctx2.email === 'zara@floom.dev');
log('first auth request: device_id preserved', ctx2.device_id === 'dev-anon-99');
log(
  'first auth request: workspace_id is a fresh personal workspace (not local)',
  ctx2.workspace_id !== DEFAULT_WORKSPACE_ID && ctx2.workspace_id.startsWith('ws_'),
);

// ---- 6. Personal workspace exists with the right slug ----
const personalWs = db
  .prepare('SELECT * FROM workspaces WHERE id = ?')
  .get(ctx2.workspace_id);
log('personal workspace exists', !!personalWs);
log('personal workspace slug derived from email local-part', personalWs.slug === 'zara');
log("personal workspace name like \"zara's workspace\"", /zara's workspace/.test(personalWs.name));
log('personal workspace plan=cloud_free', personalWs.plan === 'cloud_free');

// ---- 7. zara is admin of her personal workspace ----
const member = db
  .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
  .get(ctx2.workspace_id, 'usr_zara');
log('zara is admin of her personal workspace', member?.role === 'admin');

// ---- 8. user_active_workspace pointer set ----
const active = db
  .prepare('SELECT workspace_id FROM user_active_workspace WHERE user_id = ?')
  .get('usr_zara');
log('active workspace pointer set', active?.workspace_id === ctx2.workspace_id);

// ---- 9. rekey ran: app_memory row migrated to zara + her ws ----
const memRow = db
  .prepare(
    'SELECT * FROM app_memory WHERE app_slug = ? AND device_id = ?',
  )
  .get('rk-login', 'dev-anon-99');
log('app_memory: user_id flipped to usr_zara', memRow?.user_id === 'usr_zara');
log(
  'app_memory: workspace_id flipped to personal ws',
  memRow?.workspace_id === ctx2.workspace_id,
);

const runRow = db
  .prepare('SELECT user_id, workspace_id FROM runs WHERE id = ?')
  .get('run_rk_login');
log('runs: user_id flipped', runRow?.user_id === 'usr_zara');
log('runs: workspace_id flipped', runRow?.workspace_id === ctx2.workspace_id);

const threadRow = db
  .prepare('SELECT user_id, workspace_id FROM run_threads WHERE id = ?')
  .get('thr_rk_login');
log('run_threads: user_id flipped', threadRow?.user_id === 'usr_zara');

const conRow = db
  .prepare('SELECT owner_kind, owner_id, workspace_id FROM connections WHERE id = ?')
  .get('con_rk_login');
log('connections: owner_kind=user', conRow?.owner_kind === 'user');
log('connections: owner_id=usr_zara', conRow?.owner_id === 'usr_zara');
log('connections: workspace_id flipped', conRow?.workspace_id === ctx2.workspace_id);

// ---- 10. users.composio_user_id populated ----
const userRow = db
  .prepare('SELECT composio_user_id FROM users WHERE id = ?')
  .get('usr_zara');
log(
  'users.composio_user_id populated (device:<old>)',
  userRow?.composio_user_id === 'device:dev-anon-99',
);

// ---- 11. Second auth request: idempotent — no new rows, no new ws ----
const wsCountBefore = db
  .prepare('SELECT COUNT(*) as c FROM workspaces').get().c;
const c3 = buildHonoCtx('dev-anon-99');
const ctx3 = await session.resolveUserContext(c3);
const wsCountAfter = db
  .prepare('SELECT COUNT(*) as c FROM workspaces').get().c;
log('second auth request: no new workspace created', wsCountBefore === wsCountAfter);
log(
  'second auth request: same workspace_id',
  ctx3.workspace_id === ctx2.workspace_id,
);
log('second auth request: same user_id', ctx3.user_id === 'usr_zara');
log(
  'second auth request: composio_user_id not overwritten',
  db.prepare('SELECT composio_user_id FROM users WHERE id = ?').get('usr_zara')
    ?.composio_user_id === 'device:dev-anon-99',
);

// ---- 12. Different user logs in on the same device → second personal ws ----
fakeUser = {
  id: 'usr_yael',
  email: 'yael@floom.dev',
  name: 'Yael',
};
const c4 = buildHonoCtx('dev-anon-99');
const ctx4 = await session.resolveUserContext(c4);
log('user switch: new user_id=usr_yael', ctx4.user_id === 'usr_yael');
log(
  'user switch: brand new personal workspace',
  ctx4.workspace_id !== ctx2.workspace_id && ctx4.workspace_id.startsWith('ws_'),
);

// ---- 13. Anonymous fallback after fake getSession returns null again ----
fakeUser = null;
const c5 = buildHonoCtx('dev-anon-99');
const ctx5 = await session.resolveUserContext(c5);
log(
  'unauth fallback: workspace_id=local',
  ctx5.workspace_id === DEFAULT_WORKSPACE_ID,
);
log('unauth fallback: user_id=local', ctx5.user_id === DEFAULT_USER_ID);
log('unauth fallback: is_authenticated=false', ctx5.is_authenticated === false);

// ---- cleanup ----
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
