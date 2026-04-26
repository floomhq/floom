#!/usr/bin/env node
// ADR-012 account soft-delete coverage.
//
// Run: pnpm --filter @floom/server build && node test/stress/test-account-soft-delete.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-account-soft-delete-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER = 'true';
process.env.FLOOM_DISABLE_ACCOUNT_DELETE_SWEEPER = 'true';
process.env.FLOOM_FAST_APPS = 'false';
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.BETTER_AUTH_URL = 'http://localhost:3051';

const { db, DEFAULT_WORKSPACE_ID } = await import('../../apps/server/dist/db.js');
const auth = await import('../../apps/server/dist/lib/better-auth.js');
const {
  getUserDeletionState,
  getUserDeletionStateByEmail,
  initiateAccountSoftDelete,
  listPendingAccountDeletes,
  permanentDeleteAccount,
  revokeAccountSessions,
  softDeletedSignInBody,
  sweepExpiredAccountDeletes,
  undoAccountSoftDelete,
} = await import('../../apps/server/dist/services/account-deletion.js');
const { accountDeleteRouter } = await import('../../apps/server/dist/routes/account_delete.js');
const { adminRouter } = await import('../../apps/server/dist/routes/admin.js');

await auth.runAuthMigrations();
auth._resetAuthForTests();
const authInstance = auth.getAuth();
let fakeUser = null;
authInstance.api.getSession = async () => {
  if (!fakeUser) return null;
  return { user: fakeUser, session: { id: `sess_${fakeUser.id}` } };
};

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

function count(sql, ...params) {
  return db.prepare(sql).get(...params)?.c ?? 0;
}

function seedUser(id, email, name = id, isAdmin = 0) {
  db.prepare(
    `INSERT INTO users (id, email, name, auth_provider, auth_subject, is_admin)
     VALUES (?, ?, ?, 'better-auth', ?, ?)`,
  ).run(id, email, name, id, isAdmin);
  db.prepare(
    `INSERT OR IGNORE INTO "user" (id, email, name, emailVerified, createdAt, updatedAt)
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(id, email, name, new Date().toISOString(), new Date().toISOString());
}

function seedWorkspace(id, name = id) {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'cloud_free')`,
  ).run(id, id, name);
}

function seedMember(workspaceId, userId, role = 'admin', joinedAt = '2026-01-01T00:00:00.000Z') {
  db.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
     VALUES (?, ?, ?, ?)`,
  ).run(workspaceId, userId, role, joinedAt);
}

function seedApp(id, workspaceId, author, visibility = 'private') {
  db.prepare(
    `INSERT INTO apps
      (id, slug, name, description, manifest, app_type, code_path, workspace_id, author, visibility)
     VALUES (?, ?, ?, 'x', '{}', 'docker', '/tmp/none', ?, ?, ?)`,
  ).run(id, id, id, workspaceId, author, visibility);
}

function seedRun(id, workspaceId, userId, appId = 'app_activity') {
  if (!db.prepare('SELECT 1 FROM apps WHERE id = ?').get(appId)) {
    seedApp(appId, workspaceId, userId, 'private');
  }
  db.prepare(
    `INSERT INTO runs (id, app_id, action, inputs, status, workspace_id, user_id)
     VALUES (?, ?, 'run', '{}', 'done', ?, ?)`,
  ).run(id, appId, workspaceId, userId);
}

function seedAuthSession(userId, id = `sess_${userId}`) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "session" (id, token, expiresAt, createdAt, updatedAt, userId)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, `tok_${id}`, new Date(Date.now() + 86400000).toISOString(), now, now, userId);
}

async function fetchRoute(router, method, path, body, bearer) {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (bearer) headers.set('authorization', `Bearer ${bearer}`);
  const res = await router.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json, text };
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function extractCookie(setCookieHeader) {
  if (!setCookieHeader) return '';
  return setCookieHeader.split(';')[0] || '';
}

async function runLiveAuthSoftDeleteFlow() {
  const liveTmp = mkdtempSync(join(tmpdir(), 'floom-account-soft-delete-live-'));
  const port = await allocatePort();
  const env = {
    ...process.env,
    DATA_DIR: liveTmp,
    PORT: String(port),
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    DEPLOY_ENABLED: 'true',
    FLOOM_CLOUD_MODE: 'true',
    BETTER_AUTH_SECRET:
      '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16),
    FLOOM_DISABLE_JOB_WORKER: 'true',
    FLOOM_DISABLE_TRIGGERS_WORKER: 'true',
    FLOOM_DISABLE_ZOMBIE_SWEEPER: 'true',
    FLOOM_DISABLE_ACCOUNT_DELETE_SWEEPER: 'true',
    FLOOM_FAST_APPS: 'false',
    FLOOM_SEED_LAUNCH_DEMOS: 'false',
    RESEND_API_KEY: '',
  };
  const proc = spawn(process.execPath, [join(process.cwd(), 'apps/server/dist/index.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  proc.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  async function jsonFetch(path, body, cookie) {
    const headers = {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
    };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave null */
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/health`);
    const email = 'live-soft-delete@example.com';
    const password = 'hunter2-hunter2';
    const signup = await jsonFetch('/auth/sign-up/email', {
      email,
      password,
      name: 'Live Soft Delete',
      callbackURL: `http://127.0.0.1:${port}/after-verify`,
    });
    log('live auth: sign-up reaches Better Auth', signup.status === 200, signup.text);
    let token = null;
    const deadline = Date.now() + 5000;
    while (!token && Date.now() < deadline) {
      token = output.match(/verify-email\?token=([^&\s]+)/)?.[1] || null;
      if (!token) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    log('live auth: verification token emitted', typeof token === 'string' && token.length > 20);
    const verify = await fetch(`http://127.0.0.1:${port}/auth/verify-email?token=${encodeURIComponent(token || '')}`);
    const cookie = extractCookie(verify.headers.get('set-cookie') || '');
    log('live auth: verify issues session cookie', /^(__Secure-)?fsid=/.test(cookie), cookie);
    const del = await jsonFetch('/api/me/delete-account', { confirm_email: email }, cookie);
    log('live auth: /api/me/delete-account returns delete_at', del.status === 200 && !!del.json?.delete_at, del.text);
    const signin = await jsonFetch('/auth/sign-in/email', { email, password });
    log(
      'live auth: sign-in during grace returns 403 with undo payload',
      signin.status === 403 &&
        signin.json?.code === 'account_pending_delete' &&
        signin.json?.delete_at === del.json?.delete_at &&
        /undo/.test(signin.json?.undo_url || ''),
      signin.text,
    );
  } finally {
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.once('exit', resolve));
    rmSync(liveTmp, { recursive: true, force: true });
  }
}

console.log('ADR-012 account soft-delete tests');

try {
  const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((r) => r.name));
  log('schema: users.deleted_at exists', userCols.has('deleted_at'));
  log('schema: users.delete_at exists', userCols.has('delete_at'));

  seedUser('alice_sd', 'alice-sd@example.com', 'Alice');
  seedAuthSession('alice_sd');
  const result = initiateAccountSoftDelete('alice_sd', 'alice-sd@example.com');
  const alice = getUserDeletionState('alice_sd');
  log('soft-delete: returns delete_at', typeof result.delete_at === 'string' && result.delete_at.length > 10);
  log('soft-delete: deleted_at set', !!alice?.deleted_at);
  log('soft-delete: session revoked', count('SELECT COUNT(*) AS c FROM "session" WHERE userId = ?', 'alice_sd') === 0);
  log(
    'soft-delete: sign-in payload has 403 body fields',
    softDeletedSignInBody(alice).code === 'account_pending_delete' &&
      softDeletedSignInBody(alice).delete_at === alice.delete_at &&
      /undo/.test(softDeletedSignInBody(alice).undo_url),
  );

  let threw = null;
  try {
    initiateAccountSoftDelete('alice_sd', 'alice-sd@example.com');
  } catch (err) {
    threw = err;
  }
  log('double-delete: 409', threw?.status === 409 && threw?.code === 'account_pending_delete');

  const restored = undoAccountSoftDelete('alice-sd@example.com');
  log('undo: deleted_at cleared', restored.deleted_at === null);
  log('undo: delete_at cleared', restored.delete_at === null);
  log('undo: account is active for future sign-in', getUserDeletionState('alice_sd')?.deleted_at === null);

  seedUser('wrong_email', 'wrong-email@example.com');
  threw = null;
  try {
    initiateAccountSoftDelete('wrong_email', 'not-it@example.com');
  } catch (err) {
    threw = err;
  }
  log('wrong confirm_email: 422', threw?.status === 422 && threw?.code === 'invalid_confirm_email');

  seedUser('expired_undo', 'expired-undo@example.com');
  initiateAccountSoftDelete('expired_undo', 'expired-undo@example.com');
  db.prepare(`UPDATE users SET delete_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), 'expired_undo');
  threw = null;
  try {
    undoAccountSoftDelete('expired-undo@example.com');
  } catch (err) {
    threw = err;
  }
  log('undo after expiry: 410', threw?.status === 410 && threw?.code === 'account_delete_expired');

  seedUser('zero_state', 'zero-state@example.com');
  const zero = initiateAccountSoftDelete('zero_state', 'zero-state@example.com');
  log('zero apps/tokens/sessions: soft-delete succeeds', !!zero.delete_at);

  fakeUser = { id: 'route_user', email: 'route@example.com', name: 'Route', emailVerified: true };
  seedUser('route_user', 'route@example.com');
  let r = await fetchRoute(accountDeleteRouter, 'POST', '/', { confirm_email: 'route@example.com' });
  log('POST /api/me/delete-account: 200', r.status === 200 && !!r.json?.delete_at, r.text);
  r = await fetchRoute(accountDeleteRouter, 'POST', '/undo', { confirm_email: 'route@example.com' });
  log('POST /api/me/delete-account/undo: 200', r.status === 200 && r.json?.user?.deleted_at === null, r.text);

  fakeUser = { id: 'route_wrong', email: 'route-wrong@example.com', name: 'Route Wrong', emailVerified: true };
  seedUser('route_wrong', 'route-wrong@example.com');
  r = await fetchRoute(accountDeleteRouter, 'POST', '/', { confirm_email: 'mismatch@example.com' });
  log('route wrong confirm_email: 422', r.status === 422, r.text);
  fakeUser = null;
  r = await fetchRoute(accountDeleteRouter, 'POST', '/', { confirm_email: 'route-wrong@example.com' });
  log('route auth missing: 401', r.status === 401 && r.json?.code === 'auth_required', r.text);

  seedUser('admin_soft', 'admin-soft@example.com', 'Admin', 1);
  seedUser('pending_visible', 'pending-visible@example.com');
  initiateAccountSoftDelete('pending_visible', 'pending-visible@example.com');
  fakeUser = { id: 'admin_soft', email: 'admin-soft@example.com', name: 'Admin', emailVerified: true };
  r = await fetchRoute(adminRouter, 'GET', '/pending-deletes');
  log(
    'GET /api/admin/pending-deletes lists soft-deleted users',
    r.status === 200 && r.json?.users?.some((u) => u.id === 'pending_visible'),
    r.text,
  );
  log('service listPendingAccountDeletes includes row', listPendingAccountDeletes().some((u) => u.id === 'pending_visible'));

  seedUser('cascade_user', 'cascade@example.com');
  seedUser('cascade_bob', 'cascade-bob@example.com');
  seedWorkspace('ws_cascade');
  seedMember('ws_cascade', 'cascade_user', 'admin');
  seedMember('ws_cascade', 'cascade_bob', 'admin');
  seedApp('cascade_private', 'ws_cascade', 'cascade_user', 'private');
  seedApp('cascade_public', 'ws_cascade', 'cascade_user', 'public');
  db.prepare(
    `INSERT INTO app_invites
      (id, app_id, invited_email, state, invited_by_user_id)
     VALUES ('inv_cascade', 'cascade_public', 'x@example.com', 'pending_email', 'cascade_user')`,
  ).run();
  initiateAccountSoftDelete('cascade_user', 'cascade@example.com');
  db.prepare(`UPDATE users SET delete_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), 'cascade_user');
  const swept = sweepExpiredAccountDeletes();
  log('sweeper: deletes expired user', swept.deleted >= 1 && !getUserDeletionState('cascade_user'));
  log('sweeper: public app orphaned to local', db.prepare(`SELECT workspace_id, author FROM apps WHERE id = 'cascade_public'`).get()?.workspace_id === DEFAULT_WORKSPACE_ID);
  log('sweeper: private app deleted', count(`SELECT COUNT(*) AS c FROM apps WHERE id = 'cascade_private'`) === 0);
  log('sweeper: invited-by app invites deleted', count(`SELECT COUNT(*) AS c FROM app_invites WHERE id = 'inv_cascade'`) === 0);
  log('sweeper: shared workspace preserved', count(`SELECT COUNT(*) AS c FROM workspaces WHERE id = 'ws_cascade'`) === 1);
  log('sweeper: other workspace member preserved', count(`SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id = 'ws_cascade' AND user_id = 'cascade_bob'`) === 1);
  const secondSweep = sweepExpiredAccountDeletes();
  log('sweeper retry: idempotent no expired rows left for cascade user', secondSweep.failed === 0 && !getUserDeletionState('cascade_user'));

  seedUser('bulk_user', 'bulk@example.com');
  seedWorkspace('ws_bulk');
  seedMember('ws_bulk', 'bulk_user', 'admin');
  for (let i = 0; i < 120; i++) {
    seedApp(`bulk_private_${i}`, 'ws_bulk', 'bulk_user', 'private');
  }
  const started = Date.now();
  permanentDeleteAccount('bulk_user');
  log('100s apps: private cascade completes', count(`SELECT COUNT(*) AS c FROM apps WHERE author = 'bulk_user'`) === 0);
  log('100s apps: completes within timeout', Date.now() - started < 5000);

  seedUser('owner_user', 'owner@example.com');
  seedUser('owner_bob', 'owner-bob@example.com');
  seedUser('owner_carol', 'owner-carol@example.com');
  seedWorkspace('ws_owner');
  seedMember('ws_owner', 'owner_user', 'admin', '2026-01-01T00:00:00.000Z');
  seedMember('ws_owner', 'owner_bob', 'editor', '2026-01-02T00:00:00.000Z');
  seedMember('ws_owner', 'owner_carol', 'viewer', '2026-01-03T00:00:00.000Z');
  seedRun('run_owner_bob_1', 'ws_owner', 'owner_bob');
  seedRun('run_owner_bob_2', 'ws_owner', 'owner_bob');
  seedRun('run_owner_carol_1', 'ws_owner', 'owner_carol');
  permanentDeleteAccount('owner_user');
  log('workspace owner delete: workspace preserved', count(`SELECT COUNT(*) AS c FROM workspaces WHERE id = 'ws_owner'`) === 1);
  log(
    'workspace owner delete: next-most-active member promoted to admin',
    db.prepare(`SELECT role FROM workspace_members WHERE workspace_id = 'ws_owner' AND user_id = 'owner_bob'`).get()?.role === 'admin',
  );

  seedUser('fresh_old', 'fresh@example.com');
  permanentDeleteAccount('fresh_old');
  seedUser('fresh_new', 'fresh@example.com');
  log('same email after permanent delete: fresh account allowed', !!getUserDeletionState('fresh_new'));

  seedUser('concurrent_user', 'concurrent@example.com');
  const deletePromise = Promise.resolve().then(() => initiateAccountSoftDelete('concurrent_user', 'concurrent@example.com'));
  const undoPromise = deletePromise.then(() => undoAccountSoftDelete('concurrent@example.com'));
  await Promise.all([deletePromise, undoPromise]);
  log('concurrent delete + undo: final state active', getUserDeletionStateByEmail('concurrent@example.com')?.deleted_at === null);

  seedUser('revoke_only', 'revoke@example.com');
  seedAuthSession('revoke_only', 'sess_revoke_one');
  seedAuthSession('revoke_only', 'sess_revoke_two');
  const revoked = revokeAccountSessions('revoke_only');
  log('session revocation helper deletes all sessions', revoked === 2 && count('SELECT COUNT(*) AS c FROM "session" WHERE userId = ?', 'revoke_only') === 0);

  await runLiveAuthSoftDeleteFlow();
} finally {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
