#!/usr/bin/env node
// W2.1 session service tests. Covers:
//   - getOrCreateDeviceId cookie flow (new cookie minted, existing cookie read)
//   - resolveUserContext default shape (OSS mode)
//   - rekeyDevice transaction: counts + idempotency across app_memory/runs/threads
//   - scoped helper: throws on missing ctx, enforces workspace_id predicate
//
// Run: node test/stress/test-w21-session.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w21-session-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db, DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID } = await import(
  '../../apps/server/dist/db.js'
);
const session = await import('../../apps/server/dist/services/session.js');
const scoped = await import('../../apps/server/dist/lib/scoped.js');
const { newRunId, newThreadId, newAppId } = await import(
  '../../apps/server/dist/lib/ids.js'
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

console.log('W2.1 session + scoped tests');

// ---- fake Hono context ----
function makeCtx(cookieValue = null) {
  const headers = new Map();
  if (cookieValue) headers.set('cookie', `floom_device=${cookieValue}`);
  const responseHeaders = [];
  return {
    req: { header: (name) => headers.get(name.toLowerCase()) || null },
    header: (name, value) => responseHeaders.push([name, value]),
    _responseHeaders: responseHeaders,
  };
}

// ---- 1. getOrCreateDeviceId mints a new cookie when none is present ----
const c1 = makeCtx();
const id1 = session.getOrCreateDeviceId(c1);
log(
  'getOrCreateDeviceId: returns a non-empty id',
  typeof id1 === 'string' && id1.length > 0,
);
log(
  'getOrCreateDeviceId: sets a floom_device cookie on the response',
  c1._responseHeaders.some(
    ([k, v]) => k === 'set-cookie' && v.includes('floom_device='),
  ),
);

// ---- 2. getOrCreateDeviceId returns the existing cookie unchanged ----
const c2 = makeCtx('dev-existing-1234');
const id2 = session.getOrCreateDeviceId(c2);
log('getOrCreateDeviceId: existing cookie returned as-is', id2 === 'dev-existing-1234');

// ---- 3. resolveUserContext shape in OSS mode ----
// W3.1 made resolveUserContext async (so it can `await` Better Auth in cloud
// mode). In OSS mode the inner branch is still synchronous, but the function
// now returns a Promise — tests must await it.
const c3 = makeCtx('dev-ctx-test');
// Patch in c.req.raw so the Cloud branch's `c.req.raw.headers` access in
// session.ts doesn't crash when isCloudMode() is false. In OSS mode the
// branch short-circuits before this is read, but we provide a Headers stub
// anyway for forward-safety.
c3.req.raw = { headers: new Headers() };
const ctx = await session.resolveUserContext(c3);
log('resolveUserContext: workspace_id=local', ctx.workspace_id === DEFAULT_WORKSPACE_ID);
log('resolveUserContext: user_id=local', ctx.user_id === DEFAULT_USER_ID);
log('resolveUserContext: device_id echoed from cookie', ctx.device_id === 'dev-ctx-test');
log('resolveUserContext: is_authenticated=false', ctx.is_authenticated === false);

// ---- 4. rekeyDevice transaction: counts + idempotent ----
// Seed a fixture app so runs/app_memory FKs work.
const appId = newAppId();
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, workspace_id, memory_keys)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  appId,
  'rekey-fixture',
  'Rekey Fixture',
  'test app',
  JSON.stringify({
    name: 'Rekey Fixture',
    description: 'x',
    actions: { run: { label: 'x', inputs: [], outputs: [] } },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '2.0',
    memory_keys: ['last_search', 'fave_color'],
  }),
  'proxied:rekey',
  DEFAULT_WORKSPACE_ID,
  JSON.stringify(['last_search', 'fave_color']),
);

// Seed 2 anonymous app_memory rows for device=dev-anon
db.prepare(
  `INSERT INTO app_memory
     (workspace_id, app_slug, user_id, device_id, key, value)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run(
  DEFAULT_WORKSPACE_ID,
  'rekey-fixture',
  DEFAULT_USER_ID,
  'dev-anon',
  'last_search',
  '"berlin"',
);
db.prepare(
  `INSERT INTO app_memory
     (workspace_id, app_slug, user_id, device_id, key, value)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run(
  DEFAULT_WORKSPACE_ID,
  'rekey-fixture',
  DEFAULT_USER_ID,
  'dev-anon',
  'fave_color',
  '"blue"',
);

// Seed 1 anonymous run row with NULL user_id
const runId = newRunId();
db.prepare(
  `INSERT INTO runs (id, app_id, action, inputs, status, workspace_id, user_id, device_id)
   VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?)`,
).run(runId, appId, 'run', '{}', DEFAULT_WORKSPACE_ID, 'dev-anon');

// Seed 1 anonymous run_thread row
const threadId = newThreadId();
db.prepare(
  `INSERT INTO run_threads (id, workspace_id, user_id, device_id) VALUES (?, ?, NULL, ?)`,
).run(threadId, DEFAULT_WORKSPACE_ID, 'dev-anon');

// First rekey: anonymous → real user 'alice'
// Insert a real user first so the FK is valid.
db.prepare(
  `INSERT INTO users (id, workspace_id, auth_provider) VALUES (?, ?, 'google')`,
).run('alice', DEFAULT_WORKSPACE_ID);

const res1 = session.rekeyDevice('dev-anon', 'alice', DEFAULT_WORKSPACE_ID);
log('rekeyDevice: app_memory count=2', res1.app_memory === 2, `got ${res1.app_memory}`);
log('rekeyDevice: runs count=1', res1.runs === 1, `got ${res1.runs}`);
log('rekeyDevice: run_threads count=1', res1.run_threads === 1, `got ${res1.run_threads}`);

// Verify rows landed on alice
const aliceMemCount = db
  .prepare(
    "SELECT COUNT(*) as n FROM app_memory WHERE workspace_id = ? AND user_id = 'alice'",
  )
  .get(DEFAULT_WORKSPACE_ID).n;
log('rekeyDevice: alice now owns 2 app_memory rows', aliceMemCount === 2);

const aliceRunCount = db
  .prepare("SELECT COUNT(*) as n FROM runs WHERE user_id = 'alice'")
  .get().n;
log('rekeyDevice: alice now owns 1 run', aliceRunCount === 1);

// Second rekey: same args → zero changes (idempotent)
const res2 = session.rekeyDevice('dev-anon', 'alice', DEFAULT_WORKSPACE_ID);
log(
  'rekeyDevice: idempotent (no-op on re-run)',
  res2.app_memory === 0 && res2.runs === 0 && res2.run_threads === 0,
);

// Third rekey: non-existent device → zero changes (no crash)
const res3 = session.rekeyDevice('dev-ghost', 'alice', DEFAULT_WORKSPACE_ID);
log(
  'rekeyDevice: missing device_id yields 0/0/0',
  res3.app_memory === 0 && res3.runs === 0 && res3.run_threads === 0,
);

// ---- 5. scoped helper ----
// scopedAll: should prepend workspace_id predicate
const rowsA = scoped.scopedAll(
  db,
  { workspace_id: DEFAULT_WORKSPACE_ID, user_id: 'alice', device_id: 'd', is_authenticated: true },
  'app_memory',
  'key, value',
  'user_id = ?',
  ['alice'],
);
log('scopedAll: returns alice rows', rowsA.length === 2, `got ${rowsA.length}`);

// scopedAll with a different workspace id → zero results
const rowsWrong = scoped.scopedAll(
  db,
  { workspace_id: 'not-a-workspace', user_id: 'alice', device_id: 'd', is_authenticated: true },
  'app_memory',
  'key, value',
  'user_id = ?',
  ['alice'],
);
log('scopedAll: wrong workspace_id returns 0 rows', rowsWrong.length === 0);

// Missing workspace_id throws
let threw = false;
try {
  scoped.scopedAll(db, { workspace_id: '', user_id: 'x', device_id: 'x', is_authenticated: false }, 'app_memory', '*', null);
} catch (err) {
  threw = err.name === 'MissingContextError';
}
log('scopedAll: throws MissingContextError when workspace_id empty', threw);

// ---- cleanup ----
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
