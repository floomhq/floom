#!/usr/bin/env node
// Unit tests for the webhook delivery module. Uses a fake fetch so nothing
// goes over the network. Covers: 200 success (no retry), 5xx retry then
// success, 5xx retry exhausted, 4xx permanent failure.
//
// Run: node test/stress/test-webhook.mjs

import { deliverWebhook } from '../../apps/server/dist/services/webhook.js';

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

function makeFakeFetch(responses) {
  let calls = 0;
  const recorded = [];
  const fn = async (url, init) => {
    recorded.push({ url, init });
    const next = responses[Math.min(calls, responses.length - 1)];
    calls++;
    if (typeof next === 'function') return next();
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
    };
  };
  fn.getCalls = () => calls;
  fn.getRecorded = () => recorded;
  return fn;
}

const basePayload = {
  job_id: 'job_test',
  slug: 'slow-echo',
  status: 'succeeded',
  output: { msg: 'hi' },
  error: null,
  duration_ms: 1234,
  attempts: 1,
};

console.log('webhook delivery tests');

// 1. 200 success — no retry, one call
{
  const f = makeFakeFetch([{ status: 200 }]);
  const res = await deliverWebhook('https://hook.example/path', basePayload, {
    fetchImpl: f,
    backoffMs: 1,
  });
  log(
    '200 success: ok=true, attempts=1, one fetch call',
    res.ok === true && res.attempts === 1 && f.getCalls() === 1,
    JSON.stringify(res) + ' calls=' + f.getCalls(),
  );
  const rec = f.getRecorded()[0];
  log(
    '200 success: body contains job_id',
    rec.init.body.includes('job_test') && rec.init.headers['content-type'] === 'application/json',
  );
}

// 2. 500 → 500 → 200 success after retries
{
  const f = makeFakeFetch([{ status: 500 }, { status: 503 }, { status: 200 }]);
  const res = await deliverWebhook('https://hook.example/retry', basePayload, {
    fetchImpl: f,
    backoffMs: 1,
    maxAttempts: 3,
  });
  log(
    '5xx retry → success: ok=true, attempts=3',
    res.ok === true && res.attempts === 3 && f.getCalls() === 3,
    JSON.stringify(res),
  );
}

// 3. 500 exhausted — fail after maxAttempts
{
  const f = makeFakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
  const res = await deliverWebhook('https://hook.example/fail', basePayload, {
    fetchImpl: f,
    backoffMs: 1,
    maxAttempts: 3,
  });
  log(
    '5xx exhausted: ok=false, attempts=3, status=500',
    res.ok === false && res.attempts === 3 && res.status === 500,
    JSON.stringify(res),
  );
}

// 4. 4xx permanent — no retry
{
  const f = makeFakeFetch([{ status: 404 }]);
  const res = await deliverWebhook('https://hook.example/notfound', basePayload, {
    fetchImpl: f,
    backoffMs: 1,
    maxAttempts: 5,
  });
  log(
    '404 permanent: ok=false, attempts=1 (no retry)',
    res.ok === false && res.attempts === 1 && f.getCalls() === 1,
    JSON.stringify(res),
  );
}

// 5. network error → retry → success
{
  const f = makeFakeFetch([new Error('ECONNRESET'), { status: 200 }]);
  const res = await deliverWebhook('https://hook.example/flake', basePayload, {
    fetchImpl: f,
    backoffMs: 1,
    maxAttempts: 3,
  });
  log(
    'network error → retry → success: ok=true, attempts=2',
    res.ok === true && res.attempts === 2,
    JSON.stringify(res),
  );
}

// 6. network error exhausted
{
  const f = makeFakeFetch([
    new Error('ECONNRESET'),
    new Error('ECONNRESET'),
    new Error('ECONNRESET'),
  ]);
  const res = await deliverWebhook('https://hook.example/dead', basePayload, {
    fetchImpl: f,
    backoffMs: 1,
    maxAttempts: 3,
  });
  log(
    'network error exhausted: ok=false, attempts=3',
    res.ok === false && res.attempts === 3,
    JSON.stringify(res),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
