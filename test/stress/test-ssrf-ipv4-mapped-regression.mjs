#!/usr/bin/env node
// Regression for the IPv4-mapped-v6 SSRF bug that broke /api/hub/detect for
// EVERY public repo (issue discovered 2026-04-23 on preview.floom.dev when
// federicodeponte/openblog detection failed — SECOND time Federico raised
// "couldn't find your app file" on a repo that has a valid openapi.json).
//
// Root cause: in openapi-ingest.ts the single BlockList had
//   bl.addSubnet('::ffff:0:0', 96, 'ipv6')
// added next to the IPv4 private-range rules. Node's BlockList indexes by
// family, and having ANY v4-mapped rule present under family 'ipv6' in the
// same object appears to match every IPv4 address when check() is called
// with family 'ipv4'. Net effect: `isBlockedIp('185.199.110.133')` returned
// true, so raw.githubusercontent.com was treated as unsafe and every
// public OpenAPI URL got "Invalid or disallowed OpenAPI URL".
//
// Fix: split into SSRF_BLOCK_LIST_V4 and SSRF_BLOCK_LIST_V6, and handle
// v4-mapped v6 addresses (`::ffff:1.2.3.4` and hex `::ffff:7f00:1`) by
// extracting the embedded v4 and running it against the v4 list.
//
// This test must stay passing. If it fails, detection is broken for every
// public repo — a P0 regression.
//
// Run: node test/stress/test-ssrf-ipv4-mapped-regression.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const tmp = mkdtempSync(join(tmpdir(), 'floom-ssrf-v4m-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_FAST_APPS = 'false';

const { fetchSpec } = await import(
  '../../apps/server/dist/services/openapi-ingest.js'
);

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) {
  passed++;
  console.log(`  ok    ${label}`);
}
function fail(label, detail) {
  failed++;
  failures.push(`${label}${detail ? ' :: ' + detail : ''}`);
  console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
}

// --- Unit-level: public IPv4 must pass the SSRF guard ---
//
// We spin up a local server on 127.0.0.1 for transport, but test the guard
// via fetchSpec with allowPrivateNetwork: false and a literal host that
// would have been blocked by the bad rule if we could bind it. We can't
// actually bind 185.199.110.133 locally, so we rely on a thin "logic check":
// import the block-list primitives indirectly by running fetchSpec against
// a DNS-resolvable public host (we bypass actual network with NO_NETWORK).
// The real assertion is at the integration level below — the detect call
// against a real public openapi.json has to succeed.

console.log('SSRF block-list split: public IPv4 must NOT be blocked');

// --- Integration: detectAppFromUrl against a real public openapi.json ---
//
// Guarded by NO_NETWORK=1 so CI without outbound access can skip. The live
// test-launch-demos already exercises real network, so this is consistent.
if (process.env.NO_NETWORK === '1') {
  console.log('  skip  NO_NETWORK=1 set, skipping live openblog detection');
} else {
  const { detectAppFromUrl } = await import(
    '../../apps/server/dist/services/openapi-ingest.js'
  );
  try {
    // This was the exact URL that failed on preview: raw.githubusercontent
    // resolves to 185.199.x.x (GitHub Pages CDN IPv4). Before the fix, the
    // v4-mapped rule poisoned the check and this threw
    // "Invalid or disallowed OpenAPI URL".
    const detected = await detectAppFromUrl(
      'https://raw.githubusercontent.com/federicodeponte/openblog/main/openapi.json',
    );
    if (detected && typeof detected.slug === 'string' && detected.tools_count > 0) {
      ok(
        `detectAppFromUrl(openblog) succeeds :: slug=${detected.slug} tools=${detected.tools_count}`,
      );
    } else {
      fail('detectAppFromUrl(openblog) succeeds', JSON.stringify(detected));
    }
  } catch (err) {
    fail(
      'detectAppFromUrl(openblog) succeeds',
      err?.message || String(err),
    );
  }

  // Also exercise the `owner/repo`-style candidate fan-out (the frontend
  // normalizes bare refs server-side via the githubUrl helper; here we
  // pass the root repo URL and let fetchSpecWithFallback walk the
  // candidate paths).
  try {
    const detected = await detectAppFromUrl(
      'https://github.com/federicodeponte/openblog',
    );
    if (detected && detected.tools_count > 0) {
      ok(
        `detectAppFromUrl(openblog repo root) falls back to openapi.json :: tools=${detected.tools_count}`,
      );
    } else {
      fail('detectAppFromUrl(openblog repo root)', JSON.stringify(detected));
    }
  } catch (err) {
    // Accept if repo-root URL isn't a direct spec — the key assertion is
    // that the block-list doesn't reject the raw.githubusercontent.com
    // candidates. A non-blocked 404 from fetchSpecWithFallback would read
    // `No OpenAPI spec found at ...` — that's a pass for this test because
    // it proves the guard is no longer false-rejecting. A block-list
    // rejection would say "Invalid or disallowed OpenAPI URL".
    const msg = err?.message || String(err);
    if (msg.startsWith('Invalid or disallowed OpenAPI URL')) {
      fail('detectAppFromUrl(openblog repo root)', `BLOCK-LIST REGRESSION: ${msg}`);
    } else {
      ok(
        `detectAppFromUrl(openblog repo root) :: non-block failure is acceptable (${msg.slice(0, 60)}...)`,
      );
    }
  }
}

// --- Defense-in-depth: v4-mapped private v6 addresses still blocked ---
//
// We can test v4-mapped via literal hostnames (the URL parser accepts
// bracketed IPv6). fetchSpec should reject every v4-mapped form of a
// private IPv4.

console.log('\nv4-mapped v6 addresses still enforce the v4 block list');

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

await expectReject(
  '::ffff:127.0.0.1 still blocked',
  'http://[::ffff:127.0.0.1]/openapi.json',
);
await expectReject(
  '::ffff:10.0.0.1 (RFC1918) still blocked',
  'http://[::ffff:10.0.0.1]/openapi.json',
);
await expectReject(
  '::ffff:169.254.169.254 (metadata) still blocked',
  'http://[::ffff:169.254.169.254]/openapi.json',
);
// Hex form of v4-mapped: ::ffff:7f00:1 == ::ffff:127.0.0.1
await expectReject(
  '::ffff:7f00:1 (hex v4-mapped loopback) still blocked',
  'http://[::ffff:7f00:1]/openapi.json',
);

// --- Real loopback via allowPrivateNetwork still works ---
console.log('\nTrusted loopback still passes (allowPrivateNetwork)');
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
    ok('trusted loopback (allowPrivateNetwork: true) still works');
  } else {
    fail(
      'trusted loopback (allowPrivateNetwork: true) still works',
      JSON.stringify(spec),
    );
  }
} catch (err) {
  fail(
    'trusted loopback (allowPrivateNetwork: true) still works',
    err?.message || String(err),
  );
}
okServer.close();

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
rmSync(tmp, { recursive: true, force: true });
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
process.exit(0);
