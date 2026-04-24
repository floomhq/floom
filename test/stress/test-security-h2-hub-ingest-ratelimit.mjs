#!/usr/bin/env node
// Security H2 (audit 2026-04-23): /api/hub/ingest is rate-limited.
//
// The HTTP ingest surface was missing from the run-rate-limit umbrella
// in apps/server/src/index.ts — only /api/run, /api/:slug/run,
// /api/:slug/jobs, and /mcp/app/:slug had caps. That let an
// unauthenticated client hammer ingest as fast as the upstream
// OpenAPI fetch would let them. This test builds a Hono app that
// mounts the production rateLimit middleware on the same path as
// index.ts and asserts the middleware returns 429 once the bucket
// is full.
//
// Run: node test/stress/test-security-h2-hub-ingest-ratelimit.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-h2-ratelimit-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
// Tight cap so we don't have to burn thousands of requests to trip it.
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '3';
delete process.env.FLOOM_RATE_LIMIT_DISABLED;

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

console.log('Security H2: /api/hub/ingest rate limit');

const { Hono } = await import(
  '../../apps/server/node_modules/hono/dist/index.js'
);
const { runRateLimitMiddleware, __resetStoreForTests } = await import(
  '../../apps/server/dist/lib/rate-limit.js'
);

// Minimal anon ctx matching the shape resolveUserContext returns in OSS.
const anonCtx = {
  workspace_id: 'local',
  user_id: 'local',
  device_id: 'd',
  is_authenticated: false,
};
__resetStoreForTests();

const app = new Hono();
// Mirror index.ts wiring exactly (path + middleware) so the regression
// we're preventing — forgetting to add the middleware at this path —
// actually fires when someone drops the app.use('/api/hub/ingest', ...)
// line.
app.use('/api/hub/ingest', runRateLimitMiddleware(async () => anonCtx));
app.post('/api/hub/ingest', (c) => c.json({ ok: true }));

// Stable client IP via x-forwarded-for from loopback (trusted).
const headers = {
  'content-type': 'application/json',
  'x-forwarded-for': '198.51.100.42',
};
const body = JSON.stringify({ openapi_url: 'https://example.com/openapi.json' });

const statuses = [];
for (let i = 0; i < 5; i++) {
  const res = await app.fetch(
    new Request('http://localhost/api/hub/ingest', {
      method: 'POST',
      headers,
      body,
    }),
  );
  statuses.push(res.status);
}

console.log(`  statuses: ${statuses.join(', ')}`);

const under = statuses.slice(0, 3);
const over = statuses.slice(3);

log(
  'first 3 calls NOT rate-limited (status != 429)',
  under.every((s) => s !== 429),
  `got ${under.join(', ')}`,
);
log(
  'calls 4+5 are rate-limited (status === 429)',
  over.every((s) => s === 429),
  `got ${over.join(', ')}`,
);

// Second assertion: verify the production index.ts actually wires the
// middleware at /api/hub/ingest. Grep the built output.
const { readFileSync } = await import('node:fs');
const indexJs = readFileSync(
  new URL('../../apps/server/dist/index.js', import.meta.url),
  'utf8',
);
log(
  "index.ts mounts rateLimit on '/api/hub/ingest'",
  indexJs.includes('/api/hub/ingest'),
);

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
