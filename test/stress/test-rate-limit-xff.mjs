#!/usr/bin/env node
// Live regression: X-Forwarded-For spoofing MUST NOT bypass the anon
// rate limit (issue #142). Hits a public app 70 times from the same
// TCP peer with a fresh fake XFF each call; asserts at least some
// calls 429 once we exceed the anon cap.
//
// Run:  node test/stress/test-rate-limit-xff.mjs [url]
//   default url: https://preview.floom.dev/api/uuid/run
//
// Why this test exists: PRR v2 confirmed 30/30 calls passed with
// rotating XFF. The fix reads x-real-ip (nginx-set, non-spoofable)
// first, then falls back to the LAST entry of XFF. After the fix,
// ~60 should pass + ~10 should 429 against the 60/hr anon cap.

import { randomBytes } from 'node:crypto';

const URL_ = process.argv[2] || 'https://preview.floom.dev/api/uuid/run';
const N = 70;
const BODY = JSON.stringify({ version: 'v4', count: 1 });

function randomIp() {
  const b = randomBytes(4);
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
}

async function hit(i) {
  const xff = randomIp();
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': xff,
    },
    body: BODY,
  });
  return {
    status: res.status,
    xff,
    headers: {
      limit: res.headers.get('x-ratelimit-limit'),
      remaining: res.headers.get('x-ratelimit-remaining'),
      reset: res.headers.get('x-ratelimit-reset'),
      scope: res.headers.get('x-ratelimit-scope'),
    },
  };
}

console.log(`XFF spoof loop: ${N} × POST ${URL_}`);
const results = [];
for (let i = 0; i < N; i++) {
  // Sequential — we want the rate-limit window to fill naturally.
  const r = await hit(i);
  results.push(r);
}

const counts = results.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] || 0) + 1;
  return acc;
}, {});

console.log('\nStatus counts:');
for (const [k, v] of Object.entries(counts)) {
  console.log(`  ${k} × ${v}`);
}

// Headers audit: every response (pass or 429) should carry the
// X-RateLimit-* set.
const missingHeaders = results.filter(
  (r) =>
    !r.headers.limit ||
    !r.headers.remaining ||
    !r.headers.reset ||
    !r.headers.scope,
);
console.log(`\nResponses missing X-RateLimit-* headers: ${missingHeaders.length} / ${N}`);

let failed = 0;
const assert = (label, ok, detail) => {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
};

// Primary assertion: at least one 429. If zero 429s, the XFF spoof still
// works and #142 is not fixed. We don't pin an exact count because the
// anon cap (60/hr) bucket state depends on prior traffic — we just want
// to see the rate limiter engage.
assert(
  'at least one 429 in 70 XFF-spoofed requests',
  (counts[429] || 0) >= 1,
  `got ${JSON.stringify(counts)}`,
);

// Secondary: every response has X-RateLimit-* headers.
assert(
  'every response carries X-RateLimit-* headers',
  missingHeaders.length === 0,
  `missing on ${missingHeaders.length} responses`,
);

// Tertiary: scope on 200 is 'ip' (anon bucket) or 'app' (per-app bucket)
// — never 'user' since we sent no session cookie.
const badScope = results
  .filter((r) => r.status === 200 && r.headers.scope === 'user')
  .length;
assert(
  'no response claims scope=user for unauth caller',
  badScope === 0,
  `${badScope} responses with user scope`,
);

console.log(failed === 0 ? '\nPASS' : `\nFAIL (${failed} assertions)`);
process.exit(failed === 0 ? 0 : 1);
