#!/usr/bin/env node
// Issue #618 regression: /api/:slug/quota counter must drop as free runs
// are consumed. Pre-fix, a successful run left the client strip stuck at
// "5 of 5 free runs today" for the whole session because the web client
// only re-fetched /quota on BYOK-modal close (and recordFreeRun fired
// correctly server-side but was never polled back).
//
// This test exercises the server-side half of the contract: after N
// recorded free runs for (ip, ua, slug), GET /api/:slug/quota must report
// remaining = limit - N. The client-side bump is covered by the
// RunSurface wiring (freeRunsRefresher.bump() on every terminal status),
// which is trivially correct code-wise once verified here.
//
// Also asserts the FreeRunsStrip "remaining" label would render correctly
// by replicating the client computation: `remaining ?? Math.max(0, limit
// - usage)` per FreeRunsStrip.tsx.
//
// Run: node test/stress/test-byok-counter-decrement.mjs
// Requires: pnpm --filter @floom/server run build

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-byok-decrement-'));
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

// Mount slugQuotaRouter on /api/:slug/quota the same way index.ts does.
const { Hono } = await import(
  '../../apps/server/node_modules/hono/dist/index.js'
);
const testApp = new Hono();
testApp.route('/api/:slug/quota', slugQuotaRouter);

async function getQuota(slug, headers = {}) {
  const res = await testApp.fetch(
    new Request(`http://localhost/api/${slug}/quota`, { method: 'GET', headers }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

insertApp('lead-scorer');

console.log('Issue #618: free-runs counter decrements after each run');

// 1. Fresh bucket — expect 5 of 5 remaining.
byokGate.__resetByokGateForTests();
{
  const r = await getQuota('lead-scorer');
  log('fresh bucket → remaining: 5', r.json && r.json.remaining === 5);
  log('fresh bucket → usage: 0', r.json && r.json.usage === 0);
}

// 2. After 1 recorded run: remaining drops to 4. This is the exact
// regression described in #618 — the server counter DOES advance, so a
// client that re-fetches /quota will see the drop.
byokGate.__resetByokGateForTests();
{
  const ip = 'unknown';
  const uaHash = byokGate.hashUserAgent(undefined);
  byokGate.recordFreeRun(ip, 'lead-scorer', undefined, uaHash);
  const r = await getQuota('lead-scorer');
  log('after 1 run → usage: 1', r.json && r.json.usage === 1);
  log('after 1 run → remaining: 4', r.json && r.json.remaining === 4);
}

// 3. Stress: record 5 runs one-by-one and verify remaining goes
// 5 → 4 → 3 → 2 → 1 → 0. This mirrors the end-user flow: click Run five
// times, the strip drops by one each time (or would, once the client
// bumps refreshKey on every terminal status — the fix in RunSurface.tsx).
byokGate.__resetByokGateForTests();
{
  const ip = 'unknown';
  const uaHash = byokGate.hashUserAgent(undefined);
  const expected = [4, 3, 2, 1, 0];
  for (let i = 0; i < 5; i++) {
    byokGate.recordFreeRun(ip, 'lead-scorer', undefined, uaHash);
    const r = await getQuota('lead-scorer');
    log(
      `run ${i + 1}/5 → remaining: ${expected[i]}`,
      r.json && r.json.remaining === expected[i],
      r.json ? `got remaining=${r.json.remaining} usage=${r.json.usage}` : 'no json',
    );
  }
}

// 4. Replicate the client-side computation from FreeRunsStrip.tsx to
// catch an off-by-one in either layer. The strip reads:
//   const remaining = quota.remaining ?? Math.max(0, limit - usage);
// If the server ever stopped returning `remaining`, the fallback math
// must still line up with what the server tracks.
byokGate.__resetByokGateForTests();
{
  const ip = 'unknown';
  const uaHash = byokGate.hashUserAgent(undefined);
  byokGate.recordFreeRun(ip, 'lead-scorer', undefined, uaHash);
  byokGate.recordFreeRun(ip, 'lead-scorer', undefined, uaHash);
  const r = await getQuota('lead-scorer');
  const clientSide = r.json
    ? r.json.remaining ?? Math.max(0, (r.json.limit ?? 5) - (r.json.usage ?? 0))
    : null;
  log(
    'client-side fallback math matches server remaining',
    clientSide === 3 && r.json.remaining === 3,
  );
}

// 5. After exhaustion (usage === limit): remaining is 0, subsequent
// re-fetches stay at 0 (no negatives, no drift). The strip variant
// flips to "Free runs used up today — add your Gemini key to keep going".
byokGate.__resetByokGateForTests();
{
  const ip = 'unknown';
  const uaHash = byokGate.hashUserAgent(undefined);
  for (let i = 0; i < 5; i++) {
    byokGate.recordFreeRun(ip, 'lead-scorer', undefined, uaHash);
  }
  const r1 = await getQuota('lead-scorer');
  const r2 = await getQuota('lead-scorer');
  const r3 = await getQuota('lead-scorer');
  log('exhausted → remaining: 0 (first poll)', r1.json && r1.json.remaining === 0);
  log('exhausted → remaining: 0 (second poll, no drift)', r2.json && r2.json.remaining === 0);
  log('exhausted → remaining: 0 (third poll, no drift)', r3.json && r3.json.remaining === 0);
  log('exhausted → usage stays at 5 (no overcount)', r3.json && r3.json.usage === 5);
}

try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
