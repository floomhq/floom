#!/usr/bin/env node
// W2.1 HTTP route tests. Exercises /api/memory and /api/secrets directly
// via the exported Hono routers (no server boot). Validates:
//   - GET/POST/DELETE flows
//   - Input validation (Zod)
//   - Error envelope shape
//   - Memory-key gating returns 403
//   - Secret plaintext is never echoed back
//
// Run: node test/stress/test-w21-routes.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w21-routes-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db, DEFAULT_WORKSPACE_ID } = await import('../../apps/server/dist/db.js');
const { memoryRouter, secretsRouter } = await import(
  '../../apps/server/dist/routes/memory.js'
);
const { newAppId } = await import('../../apps/server/dist/lib/ids.js');

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

console.log('W2.1 route tests');

// ---- fixture: an app with memory_keys declared ----
const appId = newAppId();
const manifest = {
  name: 'Openpaper',
  description: 'research',
  actions: { run: { label: 'r', inputs: [], outputs: [] } },
  runtime: 'python',
  python_dependencies: [],
  node_dependencies: {},
  secrets_needed: [],
  manifest_version: '2.0',
  memory_keys: ['bookmarked_doc_ids'],
};
db.prepare(
  `INSERT INTO apps (id, slug, name, description, manifest, code_path, workspace_id, memory_keys)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  appId,
  'openpaper',
  'Openpaper',
  'research',
  JSON.stringify(manifest),
  'proxied:openpaper',
  DEFAULT_WORKSPACE_ID,
  JSON.stringify(manifest.memory_keys),
);

// ---- helper: issue a request to a Hono router ----
async function fetchRoute(router, method, path, body) {
  const url = `http://localhost${path}`;
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const req = new Request(url, init);
  const res = await router.fetch(req);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json, text, headers: res.headers };
}

// ---- 1. POST /api/memory/:slug — valid key ----
let r = await fetchRoute(memoryRouter, 'POST', '/openpaper', {
  key: 'bookmarked_doc_ids',
  value: ['doc-1', 'doc-2'],
});
log('POST /memory/openpaper valid key: 200', r.status === 200, `got ${r.status}`);
log('POST /memory/openpaper: ok=true', r.json && r.json.ok === true);

// ---- 2. POST /api/memory/:slug — undeclared key → 403 ----
r = await fetchRoute(memoryRouter, 'POST', '/openpaper', {
  key: 'evil_key',
  value: 'nope',
});
log('POST /memory/openpaper undeclared: 403', r.status === 403, `got ${r.status}`);
log(
  "POST /memory/openpaper: error.code='memory_key_not_allowed'",
  r.json && r.json.code === 'memory_key_not_allowed',
);

// ---- 3. GET /api/memory/:slug — list entries ----
r = await fetchRoute(memoryRouter, 'GET', '/openpaper');
log('GET /memory/openpaper: 200', r.status === 200);
log(
  'GET /memory/openpaper: bookmarked_doc_ids matches',
  r.json &&
    Array.isArray(r.json.entries.bookmarked_doc_ids) &&
    r.json.entries.bookmarked_doc_ids.length === 2,
);

// ---- 4. POST /api/memory/:slug — bad body shape → 400 ----
r = await fetchRoute(memoryRouter, 'POST', '/openpaper', { wrong: 'shape' });
log('POST /memory/openpaper bad body: 400', r.status === 400, `got ${r.status}`);
log("POST /memory/openpaper bad body: code='invalid_body'", r.json && r.json.code === 'invalid_body');

// ---- 5. DELETE /api/memory/:slug/:key ----
r = await fetchRoute(memoryRouter, 'DELETE', '/openpaper/bookmarked_doc_ids');
log('DELETE /memory/openpaper/bookmarked_doc_ids: 200', r.status === 200);
log('DELETE: ok=true, removed=true', r.json && r.json.ok === true && r.json.removed === true);

// ---- 6. POST /api/secrets — valid body ----
r = await fetchRoute(secretsRouter, 'POST', '/', {
  key: 'OPENAI_API_KEY',
  value: 'sk-route-test',
});
log('POST /secrets valid: 200', r.status === 200);
log('POST /secrets: ok=true', r.json && r.json.ok === true);
log('POST /secrets: plaintext NOT echoed back', !('value' in (r.json || {})));

// ---- 7. GET /api/secrets — masked list ----
r = await fetchRoute(secretsRouter, 'GET', '/');
log('GET /secrets: 200', r.status === 200);
log(
  "GET /secrets: includes OPENAI_API_KEY",
  r.json && r.json.entries && r.json.entries.some((e) => e.key === 'OPENAI_API_KEY'),
);
log(
  'GET /secrets: never returns plaintext value',
  r.json &&
    r.json.entries.every(
      (e) => !('value' in e) && !('plaintext' in e) && !('ciphertext' in e),
    ),
);

// ---- 8. POST /api/secrets — bad body → 400 ----
r = await fetchRoute(secretsRouter, 'POST', '/', { key: 'NO_VALUE' });
log('POST /secrets no value: 400', r.status === 400);
log("POST /secrets bad body: code='invalid_body'", r.json && r.json.code === 'invalid_body');

// ---- 9. DELETE /api/secrets/:key ----
r = await fetchRoute(secretsRouter, 'DELETE', '/OPENAI_API_KEY');
log('DELETE /secrets/OPENAI_API_KEY: 200', r.status === 200);
log('DELETE /secrets: removed=true', r.json && r.json.removed === true);

// ---- 10. session cookie: POST /api/memory sets a cookie on first call ----
// fetch a fresh one with no incoming cookie → response should contain a
// Set-Cookie header starting with floom_device=.
r = await fetchRoute(memoryRouter, 'GET', '/openpaper');
const setCookie = r.headers.get('set-cookie');
log('session: GET mints a floom_device cookie', setCookie && setCookie.includes('floom_device='));
log(
  'session: cookie is HttpOnly + SameSite=Lax',
  setCookie && setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Lax'),
);

// ---- cleanup ----
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
