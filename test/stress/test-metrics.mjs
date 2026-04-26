#!/usr/bin/env node
// /api/metrics endpoint: 404 when unconfigured, 401 on wrong token, 200
// with correct token + exposes the documented Prometheus series.
//
// Run: node test/stress/test-metrics.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-metrics-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_FAST_APPS = 'false';
process.env.FLOOM_SEED_LAUNCH_DEMOS = 'false';
// Pick an unusual port to avoid clashing with a live preview instance on
// 3051 or any of the sibling stress tests.
process.env.PORT = process.env.PORT || '38517';
delete process.env.METRICS_TOKEN;
delete process.env.SENTRY_SERVER_DSN;
delete process.env.FLOOM_AUTH_TOKEN;

let passed = 0;
let failed = 0;
const log = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
};

// Drive the live server via fetch for realism. `index.js` calls `serve()`
// on import, binding to the PORT env we set above.
await import('../../apps/server/dist/index.js');
// `index.js` starts the server on boot via `boot()` which calls `serve()`.
// That binds to the real port. That's fine for a test — but we want the
// app.fetch path, not the socket. Re-importing the module is idempotent
// (Node caches), so we rely on a running server for fetch-based tests.

// Give the boot sequence a moment to come up.
await new Promise((resolve) => setTimeout(resolve, 500));

const PORT = Number(process.env.PORT);
const BASE = `http://localhost:${PORT}`;

console.log('Metrics endpoint');

// 1. 404 when METRICS_TOKEN unset
{
  const res = await fetch(`${BASE}/api/metrics`);
  log('returns 404 when METRICS_TOKEN unset', res.status === 404, `got ${res.status}`);
}

// 2. 401 with wrong token
process.env.METRICS_TOKEN = 'right-token-secret-value-xyz';
{
  const res = await fetch(`${BASE}/api/metrics`, {
    headers: { authorization: 'Bearer wrong-token' },
  });
  log('401 when wrong token presented', res.status === 401, `got ${res.status}`);
}

// 3. 401 when METRICS_TOKEN set but no bearer header
{
  const res = await fetch(`${BASE}/api/metrics`);
  log('401 when token set but no header', res.status === 401, `got ${res.status}`);
}

// 4. 200 with correct token + body contains every documented series
{
  const res = await fetch(`${BASE}/api/metrics`, {
    headers: { authorization: `Bearer ${process.env.METRICS_TOKEN}` },
  });
  const body = await res.text();
  log('200 with correct token', res.status === 200, `got ${res.status}`);
  log(
    'content-type text/plain prometheus',
    res.headers.get('content-type')?.includes('text/plain'),
    res.headers.get('content-type'),
  );
  for (const metric of [
    'floom_apps_total',
    'floom_runs_total',
    'floom_active_users_last_24h',
    'floom_mcp_tool_calls_total',
    'floom_process_uptime_seconds',
    'floom_rate_limit_hits_total',
  ]) {
    log(`body contains ${metric}`, body.includes(metric));
  }
  log(
    'runs_total emits success/error/timeout series',
    body.includes('floom_runs_total{status="success"}') &&
      body.includes('floom_runs_total{status="error"}') &&
      body.includes('floom_runs_total{status="timeout"}'),
  );
  log(
    'rate_limit_hits_total emits all five scopes',
    body.includes('floom_rate_limit_hits_total{scope="ip"}') &&
      body.includes('floom_rate_limit_hits_total{scope="user"}') &&
      body.includes('floom_rate_limit_hits_total{scope="app"}') &&
      body.includes('floom_rate_limit_hits_total{scope="agent_token"}') &&
      body.includes('floom_rate_limit_hits_total{scope="mcp_ingest"}'),
  );
  log(
    'help text present for at least one metric',
    body.includes('# HELP floom_apps_total'),
  );
  log(
    'type annotation present',
    body.includes('# TYPE floom_apps_total gauge'),
  );
}

// 5. Counter module behaviors
const countersMod = await import('../../apps/server/dist/lib/metrics-counters.js');
countersMod.__resetCountersForTests();
countersMod.recordMcpToolCall('my_tool');
countersMod.recordMcpToolCall('my_tool');
countersMod.recordMcpToolCall('other_tool');
countersMod.recordRateLimitHit('ip');
countersMod.recordRateLimitHit('ip');
countersMod.recordRateLimitHit('user');
const mcp = countersMod.snapshotMcpToolCalls();
const rl = countersMod.snapshotRateLimitHits();
log('mcp counter increments per tool_name', mcp.my_tool === 2 && mcp.other_tool === 1);
log('rate-limit counter increments per scope', rl.ip === 2 && rl.user === 1);

// 6. Sentry scrub helper (no DSN needed, pure function)
const sentryMod = await import('../../apps/server/dist/lib/sentry.js');
const scrubbed = sentryMod.__testing.scrubSecrets({
  password: 'hunter2',
  api_key: 'sk-xxx',
  nested: { authorization: 'Bearer abc', ok: 'keep' },
  token: 'tk',
  normal_field: 'hello',
});
log('scrubSecrets redacts password', scrubbed.password === '[Scrubbed]');
log('scrubSecrets redacts api_key', scrubbed.api_key === '[Scrubbed]');
log('scrubSecrets redacts nested authorization', scrubbed.nested.authorization === '[Scrubbed]');
log('scrubSecrets redacts token', scrubbed.token === '[Scrubbed]');
log('scrubSecrets leaves normal fields alone', scrubbed.normal_field === 'hello');
log('scrubSecrets recurses into nested objects', scrubbed.nested.ok === 'keep');

// 7. /api/metrics is exempt from global auth gate (FLOOM_AUTH_TOKEN).
// The running server was booted without FLOOM_AUTH_TOKEN, so this is a
// compile-time-ish check: the auth middleware exempts the path. We also
// verify the enumeration in lib/auth.ts covers the trailing-slash variant
// by reading the module's middleware + hitting the path with a fake
// FLOOM_AUTH_TOKEN set on the env — the server already read the env at
// boot, so setting it here doesn't change the running process. Instead we
// unit-test the predicate by importing auth.js and constructing a ctx.
{
  // The auth middleware reads FLOOM_AUTH_TOKEN each call, so toggling it
  // here DOES affect behavior.
  process.env.FLOOM_AUTH_TOKEN = 'some-auth-token';
  const res = await fetch(`${BASE}/api/metrics`, {
    headers: { authorization: `Bearer ${process.env.METRICS_TOKEN}` },
  });
  log(
    'metrics route bypasses FLOOM_AUTH_TOKEN gate (200, not 401)',
    res.status === 200,
    `got ${res.status}`,
  );
  delete process.env.FLOOM_AUTH_TOKEN;
}

console.log(`\n${passed} passed, ${failed} failed`);
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {}
// Server keeps running; force exit.
process.exit(failed > 0 ? 1 : 0);
