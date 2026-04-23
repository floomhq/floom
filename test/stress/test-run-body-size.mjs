#!/usr/bin/env node
// Launch-hardening 2026-04-23: `runBodyLimit` middleware should reject
// oversized run bodies with HTTP 413 BEFORE rate limiting / manifest
// validation kick in, so an attacker can't burn rate budget or CPU by
// shipping 50 MB of base64 garbage.
//
// Run: node test/stress/test-run-body-size.mjs

// Resolve Hono from apps/server/node_modules (its direct dependency,
// linked via pnpm). Avoids the hoisting question at the workspace root.
import { Hono } from '../../apps/server/node_modules/hono/dist/index.js';
import {
  runBodyLimit,
  RUN_BODY_LIMIT_BYTES,
} from '../../apps/server/src/middleware/body-size.ts';

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

const app = new Hono();
app.use('*', runBodyLimit);
app.post('/run', (c) => c.json({ ok: true }));
app.get('/run', (c) => c.json({ ok: true }));

// Case 1: under limit → handler runs.
{
  const resp = await app.request('/run', {
    method: 'POST',
    headers: { 'content-length': '1024', 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: {} }),
  });
  log('under-limit passes through', resp.status === 200);
}

// Case 2: exactly at limit → handler runs.
{
  const resp = await app.request('/run', {
    method: 'POST',
    headers: {
      'content-length': String(RUN_BODY_LIMIT_BYTES),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  log('at-limit passes through', resp.status === 200);
}

// Case 3: one byte over → 413.
{
  const resp = await app.request('/run', {
    method: 'POST',
    headers: {
      'content-length': String(RUN_BODY_LIMIT_BYTES + 1),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const ok = resp.status === 413;
  log('over-limit returns 413', ok, `status=${resp.status}`);
  if (ok) {
    const body = await resp.json();
    log(
      'over-limit body is structured',
      body.error === 'request_body_too_large'
        && body.limit_bytes === RUN_BODY_LIMIT_BYTES,
    );
  }
}

// Case 4: 10 MB DoS attempt → 413 (the canonical "absurdly long input"
// case from the launch hardening brief).
{
  const resp = await app.request('/run', {
    method: 'POST',
    headers: {
      'content-length': String(10 * 1024 * 1024),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  log('10 MB payload rejected', resp.status === 413);
}

// Case 5: GET with no body is a no-op.
{
  const resp = await app.request('/run', { method: 'GET' });
  log('GET is a no-op', resp.status === 200);
}

// Case 6: escape hatch env var disables the gate.
{
  process.env.FLOOM_RUN_BODY_LIMIT_DISABLED = 'true';
  const resp = await app.request('/run', {
    method: 'POST',
    headers: {
      'content-length': String(RUN_BODY_LIMIT_BYTES + 100),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  delete process.env.FLOOM_RUN_BODY_LIMIT_DISABLED;
  log('escape hatch bypasses limit', resp.status === 200);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
