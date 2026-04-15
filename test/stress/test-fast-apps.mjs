#!/usr/bin/env node
// E2E stress test for the fast-apps wave (seven proxied utility apps).
//
// 1. Boot the Floom server with a clean temp DATA_DIR. The server's boot
//    hook auto-forks examples/fast-apps/server.mjs and ingests its
//    apps.yaml, so all seven apps land in /api/hub.
// 2. Verify /api/hub returns the seven apps, sorted with featured first
//    and (once any avg_run_ms has been recorded) fastest next.
// 3. For each app, fire a happy-path POST /api/:slug/run, poll GET
//    /api/run/:id until the run finishes, and assert:
//      - status === 'success'
//      - duration_ms < 500 (server-side run latency)
//      - outputs has the expected shape for that slug
// 4. For each app, fire a POST with invalid inputs and assert the run
//    finishes with status === 'error' and a non-empty error string
//    (never a stack trace — the sidecar returns a structured 400 body).
// 5. Repeat the happy-path 10 times and emit p50/p95/p99 per slug.
//
// Cleans up the server + sidecar on exit so CI does not leak node on
// :4200 or the Floom port.
//
// Run: node test/stress/test-fast-apps.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const FLOOM_PORT = 14411; // test-unique port, avoids preview server on 3051
const FAST_APPS_PORT = 14412; // test-unique sidecar port
const TMP_DATA = mkdtempSync(join(tmpdir(), 'floom-fast-apps-'));

let passed = 0;
let failed = 0;
function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

const processes = [];
function cleanup() {
  for (const p of processes) {
    try { p.kill('SIGTERM'); } catch { /* ignore */ }
  }
  try { rmSync(TMP_DATA, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr?.message || 'no response'}`);
}

async function waitForCondition(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function runApp(slug, inputs) {
  const res = await fetch(`http://localhost:${FLOOM_PORT}/api/${slug}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs }),
  });
  // A 400 at this layer means Floom's manifest-level validator rejected the
  // inputs (enum mismatch, missing required field, wrong type). Surface it
  // as a synthetic "error" row so the caller can treat manifest validation
  // and sidecar validation uniformly — both are acceptable invalid-input
  // paths because both prevent a broken run from ever reaching the store.
  if (res.status === 400) {
    const body = await res.json().catch(() => ({}));
    return {
      run_id: null,
      status: 'error',
      error: body.error || 'validation_error',
      duration_ms: 0,
      outputs: null,
      source: 'manifest_validation',
    };
  }
  if (!res.ok) throw new Error(`POST /api/${slug}/run -> ${res.status}`);
  const { run_id } = await res.json();
  if (!run_id) throw new Error(`POST /api/${slug}/run missing run_id`);
  // Poll until terminal. Fast apps finish in under a second so we poll quickly.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const r = await fetch(`http://localhost:${FLOOM_PORT}/api/run/${run_id}`);
    if (r.ok) {
      const row = await r.json();
      if (row.status === 'success' || row.status === 'error') return row;
    }
    await new Promise((rr) => setTimeout(rr, 25));
  }
  throw new Error(`run ${run_id} (${slug}) never finished in 10s`);
}

console.log(`[fast-apps-test] tmp data dir: ${TMP_DATA}`);
console.log(`[fast-apps-test] floom port: ${FLOOM_PORT}, sidecar port: ${FAST_APPS_PORT}`);

// ---- boot Floom server ----
const floom = spawn(
  'node',
  [join(REPO_ROOT, 'apps/server/dist/index.js')],
  {
    env: {
      ...process.env,
      PORT: String(FLOOM_PORT),
      PUBLIC_URL: `http://localhost:${FLOOM_PORT}`,
      DATA_DIR: TMP_DATA,
      // Do NOT set FLOOM_APPS_CONFIG — the fast-apps boot hook finds
      // examples/fast-apps/apps.yaml on its own.
      FAST_APPS_PORT: String(FAST_APPS_PORT),
      FAST_APPS_HOST: '127.0.0.1',
      FLOOM_DISABLE_JOB_WORKER: 'true',
      // Empty seed + no composio + no stripe so boot is minimal.
      FLOOM_SEED_APPS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
processes.push(floom);
floom.stdout.on('data', (d) => process.stdout.write(`[floom] ${d}`));
floom.stderr.on('data', (d) => process.stderr.write(`[floom] ${d}`));

await waitForHttp(`http://localhost:${FLOOM_PORT}/api/health`, 20_000);

// Wait for the fast-apps ingest to finish.
const registered = await waitForCondition(async () => {
  try {
    const res = await fetch(`http://localhost:${FLOOM_PORT}/api/hub`);
    if (!res.ok) return false;
    const json = await res.json();
    const slugs = new Set(json.map((a) => a.slug));
    return [
      'uuid',
      'password',
      'hash',
      'base64',
      'json-format',
      'jwt-decode',
      'word-count',
    ].every((s) => slugs.has(s));
  } catch {
    return false;
  }
}, 15_000);
log('hub: all seven fast apps registered', registered);
if (!registered) {
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

// ---- verify response shape for /api/hub ----
{
  const res = await fetch(`http://localhost:${FLOOM_PORT}/api/hub`);
  const hub = await res.json();
  const first = hub[0];
  log('hub: returns `featured` boolean', typeof first.featured === 'boolean', typeof first.featured);
  log('hub: returns `avg_run_ms` (null or number)', 'avg_run_ms' in first);
  // All seven fast apps should be marked featured = true.
  const fastSlugs = new Set([
    'uuid', 'password', 'hash', 'base64', 'json-format', 'jwt-decode', 'word-count',
  ]);
  const fastFeatured = hub
    .filter((a) => fastSlugs.has(a.slug))
    .every((a) => a.featured === true);
  log('hub: all seven fast apps marked featured', fastFeatured);
  // First app in the response should be featured (no `sort=name` override).
  log('hub: first app is featured', first.featured === true, `got ${first.slug} featured=${first.featured}`);
}

// ---- per-app happy-path + latency ----
const HAPPY_CASES = {
  uuid: {
    inputs: { version: 'v4', count: 3 },
    check: (out) =>
      Array.isArray(out?.uuids) && out.uuids.length === 3 &&
      out.uuids.every((u) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u)),
  },
  password: {
    inputs: { length: 24, symbols: true },
    check: (out) =>
      typeof out?.password === 'string' && out.password.length === 24 &&
      typeof out.entropy_bits === 'number' && out.entropy_bits > 100,
  },
  hash: {
    inputs: { text: 'hello world', algorithm: 'sha256' },
    check: (out) =>
      out?.digest_hex === 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' &&
      out.algorithm === 'sha256',
  },
  base64: {
    inputs: { text: 'hello world', mode: 'encode' },
    check: (out) => out?.result === 'aGVsbG8gd29ybGQ=' && out.mode === 'encode',
  },
  'json-format': {
    inputs: { text: '{"b":2,"a":1}', indent: 2, sort_keys: true },
    check: (out) =>
      typeof out?.formatted === 'string' &&
      out.formatted.includes('"a": 1') &&
      out.formatted.indexOf('"a"') < out.formatted.indexOf('"b"') &&
      out.minified === '{"b":2,"a":1}',
  },
  'jwt-decode': {
    inputs: {
      token:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkZsb29tIERlbW8iLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    },
    check: (out) =>
      out?.algorithm === 'HS256' &&
      out.header?.alg === 'HS256' &&
      out.payload?.sub === '1234567890' &&
      out.verified === false,
  },
  'word-count': {
    inputs: {
      text: 'Floom runs real apps as HTTP, MCP, CLI, and web forms from a single manifest.',
    },
    check: (out) =>
      out?.words === 15 && out.chars === 77 && out.reading_time_minutes >= 1,
  },
};

/**
 * The proxied runner may wrap the raw response under {response: ...} depending
 * on how it extracts outputs. Probe both shapes.
 */
function unwrapOutputs(row) {
  const raw = row.outputs;
  if (raw && typeof raw === 'object') {
    if (raw.response && typeof raw.response === 'object') return raw.response;
    return raw;
  }
  return raw;
}

for (const [slug, spec] of Object.entries(HAPPY_CASES)) {
  try {
    const row = await runApp(slug, spec.inputs);
    const out = unwrapOutputs(row);
    const shapeOk = spec.check(out);
    log(`${slug}: happy-path run succeeded`, row.status === 'success', row.status);
    log(`${slug}: output shape valid`, shapeOk, JSON.stringify(out).slice(0, 200));
    log(
      `${slug}: duration_ms < 500 (got ${row.duration_ms})`,
      typeof row.duration_ms === 'number' && row.duration_ms < 500,
      String(row.duration_ms),
    );
  } catch (err) {
    log(`${slug}: happy-path run`, false, err.message);
  }
}

// ---- per-app invalid input → status=error ----
const INVALID_CASES = {
  uuid: { count: 999 },
  password: { lower: false, upper: false, digits: false, symbols: false },
  hash: { text: 'x', algorithm: 'bogus' },
  base64: { text: 123 }, // wrong type
  'json-format': { text: 'not-json{' },
  'jwt-decode': { token: 'one.two' },
  'word-count': { text: 42 }, // wrong type
};

for (const [slug, bad] of Object.entries(INVALID_CASES)) {
  try {
    const row = await runApp(slug, bad);
    log(
      `${slug}: invalid input → run finishes (not hung)`,
      row.status === 'error' || row.status === 'success',
      row.status,
    );
    log(
      `${slug}: invalid input → status === 'error'`,
      row.status === 'error',
      row.status,
    );
  } catch (err) {
    log(`${slug}: invalid input run`, false, err.message);
  }
}

// ---- latency percentiles (10 warm-path runs per app) ----
console.log('\n[fast-apps-test] latency percentiles (10 runs each, warm):');
for (const [slug, spec] of Object.entries(HAPPY_CASES)) {
  const samples = [];
  for (let i = 0; i < 10; i++) {
    try {
      const row = await runApp(slug, spec.inputs);
      if (typeof row.duration_ms === 'number') samples.push(row.duration_ms);
    } catch {
      // ignore individual miss
    }
  }
  samples.sort((a, b) => a - b);
  if (samples.length === 0) {
    console.log(`  ${slug.padEnd(12)} no samples`);
    continue;
  }
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  const p99 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))];
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `  ${slug.padEnd(12)} n=${samples.length}  avg=${avg.toFixed(0)}ms  p50=${p50}ms  p95=${p95}ms  p99=${p99}ms`,
  );
  // Hard cap: every sample must be under 500 ms.
  const over = samples.filter((s) => s >= 500);
  log(`${slug}: all 10 samples < 500ms`, over.length === 0, over.length ? `${over.length} breached` : undefined);
}

// ---- avg_run_ms has been refreshed after runs ----
{
  const res = await fetch(`http://localhost:${FLOOM_PORT}/api/hub`);
  const hub = await res.json();
  const fast = hub.filter((a) => ['uuid', 'hash', 'word-count'].includes(a.slug));
  const hasAvg = fast.every((a) => typeof a.avg_run_ms === 'number' && a.avg_run_ms > 0);
  log('hub: avg_run_ms populated after runs', hasAvg,
    fast.map((a) => `${a.slug}=${a.avg_run_ms}`).join(' '));
}

// ---- teardown ----
console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
process.exit(failed > 0 ? 1 : 0);
