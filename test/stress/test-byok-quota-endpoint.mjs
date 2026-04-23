#!/usr/bin/env node
// GET /api/:slug/quota — read-only peek at the BYOK free-run budget.
//
// Exercises the HTTP layer added in PR #527 (2026-04-25). The underlying
// library (peekUsage / decideByok) is already covered by test-byok-gate.mjs;
// here we just assert the router wiring, response shape, and the two
// easy-to-regress behaviours:
//
//   1. Polling the endpoint does NOT record a free run (otherwise the UI
//      counter would double-count every time it refreshes).
//   2. The `has_user_key_hint` field echoes the caller's X-User-Api-Key
//      header so the UI can short-circuit the "add key" CTA without
//      reading localStorage twice.
//
// Run: node test/stress/test-byok-quota-endpoint.mjs
// Requires: pnpm --filter @floom/server run build

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-byok-quota-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_RATE_LIMIT_DISABLED = 'true';

const { db } = await import('../../apps/server/dist/db.js');
const { slugQuotaRouter } = await import('../../apps/server/dist/routes/run.js');
const byokGate = await import('../../apps/server/dist/lib/byok-gate.js');

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

function makeManifest(name) {
  return JSON.stringify({
    name,
    description: 'test',
    actions: { run: { label: 'Run', inputs: [], outputs: [] } },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '1.0',
  });
}

function insertApp(slug) {
  const id = `app_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(
    `INSERT INTO apps
       (id, slug, name, description, manifest, status, code_path, workspace_id, author, app_type)
     VALUES (?, ?, ?, ?, ?, 'active', 'proxied:test', 'ws-t', 'u-t', 'proxied')`,
  ).run(id, slug, slug, 'test', makeManifest(slug));
  return id;
}

// The router is declared as `new Hono<{ Variables: { slug: string } }>()`
// and reads `c.req.param('slug')`. It's only useful once mounted under
// `/api/:slug/quota` so the slug actually binds — build a tiny wrapper
// Hono here that mirrors how index.ts mounts it.
const { Hono } = await import('../../apps/server/node_modules/hono/dist/index.js');
const testApp = new Hono();
testApp.route('/api/:slug/quota', slugQuotaRouter);

async function getViaMount(slug, headers = {}) {
  const res = await testApp.fetch(
    new Request(`http://localhost/api/${slug}/quota`, {
      method: 'GET',
      headers,
    }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

// Seed: a gated slug (matches BYOK_GATED_SLUGS) and an ungated one.
insertApp('lead-scorer');
insertApp('uuid');

console.log('GET /api/:slug/quota');

// 1. Unknown slug → 404.
byokGate.__resetByokGateForTests();
{
  const r = await getViaMount('does-not-exist');
  log('unknown slug → 404', r.status === 404);
}

// 2. Ungated slug → 200 { gated: false }. No counters, no sensitive data.
{
  const r = await getViaMount('uuid');
  log('ungated slug → 200', r.status === 200);
  log('ungated slug → gated:false', r.json && r.json.gated === false);
  log(
    'ungated slug omits usage/limit',
    r.json && !('usage' in r.json) && !('limit' in r.json),
  );
}

// 3. Gated slug, fresh IP → 200 with usage=0 / remaining=5.
byokGate.__resetByokGateForTests();
{
  const r = await getViaMount('lead-scorer');
  log('gated slug fresh → 200', r.status === 200);
  log('gated slug → gated:true', r.json && r.json.gated === true);
  log('gated slug → usage:0', r.json && r.json.usage === 0);
  log('gated slug → limit:5', r.json && r.json.limit === 5);
  log('gated slug → remaining:5', r.json && r.json.remaining === 5);
  log(
    'gated slug → window_ms: 24h',
    r.json && r.json.window_ms === 24 * 60 * 60 * 1000,
  );
  log(
    'gated slug → has_user_key_hint:false without header',
    r.json && r.json.has_user_key_hint === false,
  );
}

// 4. Key #1 launch guarantee: GETting the endpoint does NOT record a run.
// We call it 20 times then verify peekUsage for the same bucket is still 0.
// All requests in this harness collapse to IP='unknown' (no peer socket).
byokGate.__resetByokGateForTests();
{
  for (let i = 0; i < 20; i++) {
    await getViaMount('lead-scorer');
  }
  const uaHash = byokGate.hashUserAgent(undefined);
  const usage = byokGate.peekUsage('unknown', 'lead-scorer', undefined, uaHash);
  log('polling quota does not record runs (usage stays 0)', usage === 0);
}

// 5. Quota counter advances after actual free runs. The HTTP extractIp()
// only trusts x-forwarded-for when the peer socket is a trusted-proxy
// CIDR; under this test harness there's no peer socket at all, so every
// request collapses to IP='unknown'. We record runs against the same
// 'unknown' bucket so the endpoint's peek reads what we wrote.
byokGate.__resetByokGateForTests();
{
  const ip = 'unknown';
  const uaHash = byokGate.hashUserAgent(undefined);
  byokGate.recordFreeRun(ip, 'lead-scorer', undefined, uaHash);
  byokGate.recordFreeRun(ip, 'lead-scorer', undefined, uaHash);
  const r = await getViaMount('lead-scorer');
  log('after 2 recorded runs → usage:2', r.json && r.json.usage === 2);
  log('after 2 recorded runs → remaining:3', r.json && r.json.remaining === 3);
}

// 6. X-User-Api-Key header → has_user_key_hint:true (echo only; never
// persisted, never returned). Extraction rejects short/blank keys.
byokGate.__resetByokGateForTests();
{
  const withShort = await getViaMount('lead-scorer', {
    'x-user-api-key': 'AIza',
  });
  log(
    'short key → has_user_key_hint:false',
    withShort.json && withShort.json.has_user_key_hint === false,
  );
  const withReal = await getViaMount('lead-scorer', {
    'x-user-api-key': 'AIza' + 'X'.repeat(30),
  });
  log(
    'real-length key → has_user_key_hint:true',
    withReal.json && withReal.json.has_user_key_hint === true,
  );
  // Remaining should still read the "free" budget since the endpoint is
  // a read-only peek; BYOK callers don't consume the free budget when
  // they *run*, but that's decided at POST /api/run, not here.
  log(
    'has_user_key_hint=true does not hide usage/limit fields',
    withReal.json &&
      typeof withReal.json.usage === 'number' &&
      typeof withReal.json.limit === 'number',
  );
}

// 7. Exhausted budget still returns 200 (remaining=0). The UI renders
// "Free runs used up · add Gemini key" — the block happens on POST.
byokGate.__resetByokGateForTests();
{
  const ip = 'unknown';
  const uaHash = byokGate.hashUserAgent(undefined);
  for (let i = 0; i < 5; i++) {
    byokGate.recordFreeRun(ip, 'lead-scorer', undefined, uaHash);
  }
  const r = await getViaMount('lead-scorer');
  log('exhausted budget → 200 (not 429)', r.status === 200);
  log('exhausted budget → remaining:0', r.json && r.json.remaining === 0);
  log('exhausted budget → usage:5', r.json && r.json.usage === 5);
}

try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
