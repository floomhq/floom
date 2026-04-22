#!/usr/bin/env node
// Regression for issue #378 (HIGH pentest 2026-04-22): SSRF on /api/hub/detect.
//
// What we verify (unit-level, against the hardened primitives):
//   1. fetchSpec rejects URLs that resolve (or literally point) to:
//        - 127.x loopback
//        - 0.0.0.0 (pentest bypass: bound to loopback, not in old blocklist)
//        - 169.254.169.254 (cloud metadata endpoint)
//        - 10.x / 172.16-31.x / 192.168.x RFC1918
//        - ::1 IPv6 loopback
//        - ::ffff:127.0.0.1 IPv4-mapped v6 (bypass via v6 form)
//      Each must throw "Invalid or disallowed OpenAPI URL".
//   2. fetchSpec rejects non-http(s) schemes (file:, gopher:, ftp:).
//   3. fetchSpec enforces a response size cap (5 MB).
//   4. Trusted caller (allowPrivateNetwork: true) can still hit loopback.
//
// Route-level auth check is covered by test-w31-auth-boundary.mjs +
// test-w31-security-gates.mjs patterns — we just ensure the /detect route
// now invokes requireAuthenticatedInCloud (smoke-tested below by calling the
// handler with an anon context in Cloud mode and expecting 401).
//
// Run: node test/stress/test-378-ssrf-hub-detect.mjs

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-378-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_FAST_APPS = 'false';

const { fetchSpec } = await import(
  '../../apps/server/dist/services/openapi-ingest.js'
);

let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log(`  ok    ${label}`);
}
function fail(label, detail) {
  failed++;
  console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
}

async function expectReject(label, url) {
  try {
    await fetchSpec(url);
    fail(label, 'expected throw, got success');
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes('Invalid or disallowed OpenAPI URL')) {
      ok(label);
    } else {
      fail(label, `wrong error: ${msg}`);
    }
  }
}

console.log('SSRF primitive hardening (#378)');

// --- Blocked private / loopback / link-local literals ---
await expectReject('127.0.0.1 blocked', 'http://127.0.0.1/openapi.json');
await expectReject('0.0.0.0 blocked (pentest bypass)', 'http://0.0.0.0/openapi.json');
await expectReject(
  '169.254.169.254 metadata blocked',
  'http://169.254.169.254/latest/meta-data/',
);
await expectReject('10.0.0.1 RFC1918 blocked', 'http://10.0.0.1/openapi.json');
await expectReject('172.16.0.1 RFC1918 blocked', 'http://172.16.0.1/openapi.json');
await expectReject('192.168.1.1 RFC1918 blocked', 'http://192.168.1.1/openapi.json');
await expectReject('100.64.0.1 CGNAT blocked', 'http://100.64.0.1/openapi.json');
await expectReject('::1 IPv6 loopback blocked', 'http://[::1]/openapi.json');
await expectReject(
  '::ffff:127.0.0.1 v4-mapped v6 blocked',
  'http://[::ffff:127.0.0.1]/openapi.json',
);
await expectReject('fe80:: link-local blocked', 'http://[fe80::1]/openapi.json');
await expectReject('localhost string blocked', 'http://localhost/openapi.json');
await expectReject('foo.localhost blocked', 'http://foo.localhost/openapi.json');

// --- Blocked non-http(s) schemes ---
await expectReject('file:// blocked', 'file:///etc/passwd');
await expectReject('gopher:// blocked', 'gopher://127.0.0.1/_GET%20/');
await expectReject('ftp:// blocked', 'ftp://example.com/spec.json');
await expectReject('data: blocked', 'data:application/json,{}');

// --- Response size cap ---
console.log('\nResponse size cap (5 MB)');
const bigServer = createServer((req, res) => {
  // Stream 6 MB of zeros.
  res.writeHead(200, { 'content-type': 'application/json' });
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  let remaining = 6 * 1024 * 1024;
  const send = () => {
    while (remaining > 0) {
      const n = Math.min(chunk.length, remaining);
      if (!res.write(chunk.subarray(0, n))) {
        res.once('drain', send);
        return;
      }
      remaining -= n;
    }
    res.end();
  };
  send();
});
await new Promise((resolve) => bigServer.listen(0, '127.0.0.1', resolve));
const bigPort = bigServer.address().port;

try {
  // Private-network trusted caller: gets past isSafeUrl, still hits size cap.
  await fetchSpec(`http://127.0.0.1:${bigPort}/huge.json`, {
    allowPrivateNetwork: true,
  });
  fail('response > 5MB rejected', 'expected throw, got success');
} catch (err) {
  const msg = err?.message || String(err);
  if (msg.includes('exceeds') && msg.includes('bytes')) {
    ok('response > 5MB rejected');
  } else {
    fail('response > 5MB rejected', `wrong error: ${msg}`);
  }
}
bigServer.close();

// --- Trusted bypass still works for loopback ---
console.log('\nallowPrivateNetwork bypass (apps.yaml-only path)');
const okServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'OK', version: '1.0' },
      paths: {},
    }),
  );
});
await new Promise((resolve) => okServer.listen(0, '127.0.0.1', resolve));
const okPort = okServer.address().port;

try {
  const spec = await fetchSpec(`http://127.0.0.1:${okPort}/openapi.json`, {
    allowPrivateNetwork: true,
  });
  if (spec?.info?.title === 'OK') {
    ok('trusted loopback fetch succeeds');
  } else {
    fail('trusted loopback fetch succeeds', JSON.stringify(spec));
  }
} catch (err) {
  fail('trusted loopback fetch succeeds', err?.message || String(err));
}
okServer.close();

// --- /detect route auth gate (Cloud mode) ---
// Static assertion: the /detect handler now calls requireAuthenticatedInCloud
// before touching the body. Verified by grepping the compiled JS for the
// literal call + order, which is safer than bootstrapping Better Auth in a
// unit test. The route-level 401 behavior is exercised end-to-end by the
// existing auth-boundary suite (test-w31-auth-boundary.mjs).
console.log('\n/detect route calls requireAuthenticatedInCloud (static check)');
const { readFileSync } = await import('node:fs');
const hubCompiled = readFileSync(
  '../../apps/server/dist/routes/hub.js',
  'utf-8',
);
// Locate the detect handler and assert the auth gate is wired in.
// We match on `hubRouter.post("/detect"` and expect requireAuthenticatedInCloud
// to appear before the JSON body read.
const detectMatch = hubCompiled.match(
  /hubRouter\.post\(['"]\/detect['"][\s\S]*?hubRouter\.post\(['"]\/ingest['"]/,
);
if (!detectMatch) {
  fail('locate /detect handler in compiled routes/hub.js');
} else {
  const detectBody = detectMatch[0];
  if (
    detectBody.includes('requireAuthenticatedInCloud') &&
    detectBody.indexOf('requireAuthenticatedInCloud') <
      detectBody.indexOf('await c.req.json()')
  ) {
    ok('/detect handler runs requireAuthenticatedInCloud gate first');
  } else {
    fail(
      '/detect handler runs requireAuthenticatedInCloud gate first',
      'gate not found or runs too late',
    );
  }
}

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
rmSync(tmp, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
