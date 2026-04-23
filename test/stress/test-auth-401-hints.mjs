#!/usr/bin/env node
// Actionable-hint audit for every 401/403 auth response (#536, ax-eval
// baseline 2026-04-23). Asserts that:
//
//   1. The exported AUTH_* constants exist and point callers at a concrete
//      next step (CLI command, env var, or docs URL).
//   2. The canonical `notOwnerResponse` helper emits a body that contains
//      the hint and docs_url fields.
//   3. POST /api/hub/ingest in Cloud mode returns a 401 whose body carries
//      `hint` (mentioning `floom auth`) and `docs_url`.
//   4. The global-auth middleware (FLOOM_AUTH_TOKEN set) returns a 401
//      whose body carries the self-host hint (`FLOOM_AUTH_TOKEN`).
//
// The server build step must run first:
//   pnpm --filter server build
//   node test/stress/test-auth-401-hints.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate DB + env so this test never sees another test's state.
const tmp = mkdtempSync(join(tmpdir(), 'floom-auth-hints-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
// Cloud mode gates /api/hub/ingest behind authentication; we want that
// path to fire so we can assert the 401 hint shape.
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET || 'a'.repeat(64);
process.env.BETTER_AUTH_URL =
  process.env.BETTER_AUTH_URL || 'http://localhost:3051';

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

// ---------- 1. Constants ----------

const authMod = await import('../../apps/server/dist/lib/auth.js');

console.log('auth constants');
log(
  'AUTH_DOCS_URL points to the docs site',
  typeof authMod.AUTH_DOCS_URL === 'string' &&
    authMod.AUTH_DOCS_URL.startsWith('https://floom.dev/docs/'),
);
log(
  'AUTH_HINT_CLOUD mentions `floom auth`',
  typeof authMod.AUTH_HINT_CLOUD === 'string' &&
    authMod.AUTH_HINT_CLOUD.includes('floom auth'),
);
log(
  'AUTH_HINT_CLOUD mentions FLOOM_API_KEY',
  authMod.AUTH_HINT_CLOUD.includes('FLOOM_API_KEY'),
);
log(
  'AUTH_HINT_SELFHOST mentions FLOOM_AUTH_TOKEN',
  typeof authMod.AUTH_HINT_SELFHOST === 'string' &&
    authMod.AUTH_HINT_SELFHOST.includes('FLOOM_AUTH_TOKEN'),
);
log(
  'AUTH_HINT_NOT_OWNER is actionable (mentions sign in)',
  typeof authMod.AUTH_HINT_NOT_OWNER === 'string' &&
    /sign in/i.test(authMod.AUTH_HINT_NOT_OWNER),
);

// Hints must NEVER leak internal details. Cheap sanity net.
const FORBIDDEN_LEAK = [
  'stack',
  'node_modules',
  'better-sqlite3',
  'process.env',
  'Error:',
  '/root/',
  'apps/server',
];
for (const hint of [
  authMod.AUTH_HINT_CLOUD,
  authMod.AUTH_HINT_SELFHOST,
  authMod.AUTH_HINT_SIGNATURE,
  authMod.AUTH_HINT_NOT_OWNER,
]) {
  for (const needle of FORBIDDEN_LEAK) {
    log(
      `hint does not leak "${needle}"`,
      !hint.includes(needle),
      `hint="${hint}"`,
    );
  }
}

// ---------- 2. notOwnerResponse helper ----------

console.log('\nnotOwnerResponse helper');

// Build a minimal Hono-like context stub. `c.json(body, status)` is the
// only surface used by the helper, so that's all we need to mock.
function makeCtx() {
  return {
    json(body, status) {
      return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

{
  const res = authMod.notOwnerResponse(makeCtx());
  log('notOwnerResponse returns 403', res.status === 403);
  const body = await res.json();
  log('notOwnerResponse body.code === not_owner', body.code === 'not_owner');
  log(
    'notOwnerResponse body.hint is actionable',
    typeof body.hint === 'string' && body.hint.length > 10,
  );
  log(
    'notOwnerResponse body.docs_url is set',
    typeof body.docs_url === 'string' && body.docs_url.startsWith('https://'),
  );
}

// ---------- 3. /api/hub/ingest 401 shape ----------

console.log('\n/api/hub/ingest 401 shape (Cloud mode, anon)');

const { hubRouter } = await import('../../apps/server/dist/routes/hub.js');

async function callRouter(router, method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const req = new Request(`http://localhost${path}`, init);
  const res = await router.fetch(req);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json, raw: text };
}

{
  const r = await callRouter(hubRouter, 'POST', '/ingest', {
    openapi_url: 'https://example.com/openapi.yaml',
  });
  log('POST /ingest returns 401 for anon in Cloud mode', r.status === 401);
  log('body.code === auth_required', r.body && r.body.code === 'auth_required');
  log(
    'body.hint mentions `floom auth`',
    r.body && typeof r.body.hint === 'string' && r.body.hint.includes('floom auth'),
    `hint=${r.body && r.body.hint}`,
  );
  log(
    'body.hint mentions FLOOM_API_KEY',
    r.body && r.body.hint && r.body.hint.includes('FLOOM_API_KEY'),
  );
  log(
    'body.docs_url is set to a floom.dev URL',
    r.body &&
      typeof r.body.docs_url === 'string' &&
      r.body.docs_url.startsWith('https://floom.dev/'),
  );
  // Never leak internals through the error message either.
  const serialized = JSON.stringify(r.body || {});
  for (const needle of FORBIDDEN_LEAK) {
    log(
      `401 body does not leak "${needle}"`,
      !serialized.includes(needle),
      `body=${serialized}`,
    );
  }
}

// ---------- 4. Global-auth middleware (FLOOM_AUTH_TOKEN) ----------

console.log('\nglobalAuthMiddleware 401 shape');

// Fresh Hono app with the middleware mounted, so we don't need to reboot
// the full server. The middleware reads FLOOM_AUTH_TOKEN at call time.
process.env.FLOOM_AUTH_TOKEN = 'test-token-xyz';

const { Hono } = await import('../../apps/server/node_modules/hono/dist/index.js');
const app = new Hono();
app.use('*', authMod.globalAuthMiddleware);
app.get('/api/probe', (c) => c.json({ ok: true }));

{
  const res = await app.fetch(new Request('http://localhost/api/probe'));
  log('global auth rejects missing token with 401', res.status === 401);
  const body = await res.json();
  log('body.code === auth_required', body.code === 'auth_required');
  log(
    'body.hint mentions FLOOM_AUTH_TOKEN',
    typeof body.hint === 'string' && body.hint.includes('FLOOM_AUTH_TOKEN'),
    `hint=${body.hint}`,
  );
  log(
    'body.docs_url set',
    typeof body.docs_url === 'string' && body.docs_url.startsWith('https://'),
  );
}

{
  const res = await app.fetch(
    new Request('http://localhost/api/probe', {
      headers: { authorization: 'Bearer test-token-xyz' },
    }),
  );
  log('global auth accepts valid token (200)', res.status === 200);
}

// ---------- 5. feedback admin 401/403 shape ----------
//
// Codex #557 finding: /api/feedback admin was missing `docs_url` + leaked
// env-var names in hints. Cover all three auth paths (disabled, key-in-
// query, unauthorized).

console.log('\n/api/feedback admin auth shapes');

const { feedbackRouter } = await import(
  '../../apps/server/dist/routes/feedback.js'
);

async function callFeedback(method, url, init = {}) {
  const res = await feedbackRouter.fetch(
    new Request(`http://localhost${url}`, { method, ...init }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json, raw: text };
}

// 5a. Admin key not configured → 403 structured response
const prevFeedbackAdminKey = process.env.FLOOM_FEEDBACK_ADMIN_KEY;
delete process.env.FLOOM_FEEDBACK_ADMIN_KEY;
{
  const r = await callFeedback('GET', '/');
  log('feedback admin (unset) returns 403', r.status === 403);
  log('body.code === admin_disabled', r.body && r.body.code === 'admin_disabled');
  log(
    'body.hint exists and is actionable',
    r.body && typeof r.body.hint === 'string' && r.body.hint.length > 10,
  );
  log(
    'body.hint does NOT leak FLOOM_FEEDBACK_ADMIN_KEY',
    r.body && r.body.hint && !r.body.hint.includes('FLOOM_FEEDBACK_ADMIN_KEY'),
    `hint=${r.body && r.body.hint}`,
  );
  log(
    'body.docs_url is a floom.dev URL',
    r.body &&
      typeof r.body.docs_url === 'string' &&
      r.body.docs_url.startsWith('https://floom.dev/'),
  );
}

// 5b. Admin key configured, missing from request → 401 structured
process.env.FLOOM_FEEDBACK_ADMIN_KEY = 'feedback-test-key-xyz';
{
  const r = await callFeedback('GET', '/');
  log('feedback admin (wrong key) returns 401', r.status === 401);
  log('body.code === unauthorized', r.body && r.body.code === 'unauthorized');
  log(
    'body.hint does NOT leak FLOOM_FEEDBACK_ADMIN_KEY',
    r.body && r.body.hint && !r.body.hint.includes('FLOOM_FEEDBACK_ADMIN_KEY'),
    `hint=${r.body && r.body.hint}`,
  );
  log(
    'body.docs_url set',
    r.body &&
      typeof r.body.docs_url === 'string' &&
      r.body.docs_url.startsWith('https://'),
  );
}

// 5c. Admin key in query string → 401 structured with docs_url
{
  const r = await callFeedback('GET', '/?admin_key=feedback-test-key-xyz');
  log(
    'feedback admin (key in query) returns 401',
    r.status === 401,
  );
  log(
    'body.code === admin_key_in_query',
    r.body && r.body.code === 'admin_key_in_query',
  );
  log(
    'body.docs_url set',
    r.body &&
      typeof r.body.docs_url === 'string' &&
      r.body.docs_url.startsWith('https://'),
  );
}

// 5d. No leakage across all three feedback admin responses
const feedbackResponses = [
  await callFeedback('GET', '/'),
  await callFeedback('GET', '/?admin_key=feedback-test-key-xyz'),
];
delete process.env.FLOOM_FEEDBACK_ADMIN_KEY;
feedbackResponses.push(await callFeedback('GET', '/'));
if (prevFeedbackAdminKey !== undefined) {
  process.env.FLOOM_FEEDBACK_ADMIN_KEY = prevFeedbackAdminKey;
}
for (const r of feedbackResponses) {
  const serialized = JSON.stringify(r.body || {});
  for (const needle of FORBIDDEN_LEAK) {
    log(
      `feedback ${r.status} body does not leak "${needle}"`,
      !serialized.includes(needle),
      `body=${serialized}`,
    );
  }
  // Env var names are a recon leak even if not in FORBIDDEN_LEAK.
  log(
    `feedback ${r.status} body does not leak FLOOM_FEEDBACK_ADMIN_KEY`,
    !serialized.includes('FLOOM_FEEDBACK_ADMIN_KEY'),
    `body=${serialized}`,
  );
}

// ---------- 6. webhook bad-signature 401 shape ----------

console.log('\n/hook/:path bad-signature 401 shape');

const { webhookRouter } = await import(
  '../../apps/server/dist/routes/webhook.js'
);

// Seed a trigger row so the webhook handler reaches the signature check
// rather than 404ing on path lookup. The synthetic 'local' workspace/user
// already exist from db.ts bootstrap.
const { db: webhookDb } = await import('../../apps/server/dist/db.js');
webhookDb
  .prepare(
    `INSERT INTO apps (id, slug, name, description, manifest, code_path, status, workspace_id, visibility)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 'local', 'public')`,
  )
  .run(
    'app_hook_test',
    'hook-test',
    'Hook Test',
    'fixture',
    JSON.stringify({
      slug: 'hook-test',
      name: 'Hook Test',
      version: '1',
      actions: { run: { name: 'run', inputs: [], outputs: [] } },
    }),
    '/tmp/hook-test',
  );
webhookDb
  .prepare(
    `INSERT INTO triggers (id, app_id, user_id, workspace_id, trigger_type, action, inputs, enabled, webhook_url_path, webhook_secret)
     VALUES (?, ?, 'local', 'local', 'webhook', 'run', '{}', 1, ?, ?)`,
  )
  .run(
    'trg_test',
    'app_hook_test',
    'test-hook-path',
    'shared-secret-value',
  );

{
  const res = await webhookRouter.fetch(
    new Request('http://localhost/test-hook-path', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-floom-signature': 'sha256=deadbeef',
      },
      body: JSON.stringify({ hello: 'world' }),
    }),
  );
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  log('webhook bad-sig returns 401', res.status === 401);
  log('body.code === bad_signature', body && body.code === 'bad_signature');
  log(
    'body.hint mentions HMAC',
    body && typeof body.hint === 'string' && body.hint.includes('HMAC'),
    `hint=${body && body.hint}`,
  );
  log(
    'body.docs_url set',
    body &&
      typeof body.docs_url === 'string' &&
      body.docs_url.startsWith('https://'),
  );
  const serialized = JSON.stringify(body || {});
  for (const needle of FORBIDDEN_LEAK) {
    log(
      `webhook 401 body does not leak "${needle}"`,
      !serialized.includes(needle),
      `body=${serialized}`,
    );
  }
  // Uniform operator-secret absence check — matches feedback/metrics coverage.
  // The signature check uses the per-trigger `webhook_secret` DB column; the
  // adjacent operator env is `FLOOM_AUTH_TOKEN`. Neither the column name, the
  // env name, nor the actual seeded secret value may appear in the 401 body.
  for (const needle of [
    'webhook_secret',
    'FLOOM_AUTH_TOKEN',
    'shared-secret-value',
  ]) {
    log(
      `webhook 401 body does not leak "${needle}"`,
      !serialized.includes(needle),
      `body=${serialized}`,
    );
  }
}

// ---------- 7. metrics 401 shape ----------

console.log('\n/api/metrics 401 shape');

// Reset module cache: metrics.ts caches a module-scoped `cache` object and
// reads METRICS_TOKEN at call time. We only need to flip the env.
const { metricsRouter, __resetMetricsCacheForTests } = await import(
  '../../apps/server/dist/routes/metrics.js'
);
__resetMetricsCacheForTests();

const prevMetricsToken = process.env.METRICS_TOKEN;
process.env.METRICS_TOKEN = 'metrics-test-token-xyz';

{
  const res = await metricsRouter.fetch(
    new Request('http://localhost/', { method: 'GET' }),
  );
  log('metrics (no token) returns 401', res.status === 401);
  log(
    'metrics 401 is application/json (not text/plain)',
    (res.headers.get('content-type') || '').includes('application/json'),
    `content-type=${res.headers.get('content-type')}`,
  );
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  log('body.code === auth_required', body && body.code === 'auth_required');
  log(
    'body.hint does NOT leak METRICS_TOKEN',
    body && body.hint && !body.hint.includes('METRICS_TOKEN'),
    `hint=${body && body.hint}`,
  );
  log(
    'body.docs_url set',
    body &&
      typeof body.docs_url === 'string' &&
      body.docs_url.startsWith('https://'),
  );
  const serialized = JSON.stringify(body || {});
  for (const needle of FORBIDDEN_LEAK) {
    log(
      `metrics 401 body does not leak "${needle}"`,
      !serialized.includes(needle),
      `body=${serialized}`,
    );
  }
  // Env var name leak check (not in FORBIDDEN_LEAK but still a recon signal).
  log(
    'metrics 401 body does not leak METRICS_TOKEN anywhere',
    !serialized.includes('METRICS_TOKEN'),
    `body=${serialized}`,
  );
}

if (prevMetricsToken !== undefined) {
  process.env.METRICS_TOKEN = prevMetricsToken;
} else {
  delete process.env.METRICS_TOKEN;
}

// ---------- 8. MCP ingest_app auth gate in Cloud mode ----------
//
// The MCP admin surface wraps its auth rejection in a JSON-RPC tool-call
// payload. The hint + docs_url must still be present in the embedded JSON
// body so agent clients (Claude Desktop, Cursor) can act on it.

console.log('\n/mcp ingest_app Cloud-mode auth shape');

// Re-import mcp with cloud flag flipped so isCloudMode() returns true. We
// already set FLOOM_CLOUD_MODE above; mcp.js imports better-auth which
// reads that env at call time via isCloudMode().
const mcpMod = await import(
  `../../apps/server/dist/routes/mcp.js?authhints=${Date.now()}`
);

{
  const res = await mcpMod.mcpRouter.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'ingest_app',
          arguments: {
            openapi_url: 'https://example.com/openapi.json',
            slug: 'cloud-block-hints',
          },
        },
      }),
    }),
  );
  const text = await res.text();
  let envelope = null;
  try {
    envelope = JSON.parse(text);
  } catch {}
  log('mcp ingest_app unauth returns isError', envelope?.result?.isError === true);
  const rawPayload = envelope?.result?.content?.[0]?.text;
  let payload = null;
  try {
    payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : null;
  } catch {}
  log('mcp payload.code === auth_required', payload && payload.code === 'auth_required');
  // Uniform shape: `error` is a human-readable message (not the machine code).
  // Round 2 left the MCP payload with `error: 'auth_required'` + an extra
  // `message` field, breaking the `{error, code, hint, docs_url}` contract
  // used everywhere else. Assert the normalized shape.
  log(
    'mcp payload.error is a human message (not the machine code)',
    payload && typeof payload.error === 'string' && payload.error !== 'auth_required' && payload.error.length > 10,
    `error=${payload && payload.error}`,
  );
  log(
    'mcp payload has no extra `message` field (uniform shape)',
    payload && payload.message === undefined,
    `message=${payload && payload.message}`,
  );
  log(
    'mcp payload.hint mentions `floom auth`',
    payload && typeof payload.hint === 'string' && payload.hint.includes('floom auth'),
    `hint=${payload && payload.hint}`,
  );
  log(
    'mcp payload.docs_url is a floom.dev URL',
    payload &&
      typeof payload.docs_url === 'string' &&
      payload.docs_url.startsWith('https://floom.dev/'),
  );
  const serialized = rawPayload || '';
  for (const needle of FORBIDDEN_LEAK) {
    log(
      `mcp ingest_app payload does not leak "${needle}"`,
      !serialized.includes(needle),
      `payload=${serialized}`,
    );
  }
  // Uniform operator-env absence check — matches feedback/metrics coverage.
  // The MCP Cloud-mode auth gate is driven by operator-only env vars
  // (`FLOOM_CLOUD_MODE`, `BETTER_AUTH_SECRET`). Their names must never
  // appear in the agent-facing payload.
  for (const needle of ['BETTER_AUTH_SECRET', 'FLOOM_CLOUD_MODE']) {
    log(
      `mcp ingest_app payload does not leak "${needle}"`,
      !serialized.includes(needle),
      `payload=${serialized}`,
    );
  }
}

// ---------- Teardown ----------

try {
  rmSync(tmp, { recursive: true, force: true });
} catch {}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
