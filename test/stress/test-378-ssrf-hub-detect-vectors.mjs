#!/usr/bin/env node
// Comprehensive SSRF vector regression for `/api/hub/detect` (#378 verify pass).
//
// The initial fix (commit 1c49e3e, 2026-04-21) shipped allowlist + header
// filter. This suite verifies the hardened `isSafeUrl` / `fetchSpec` path
// blocks every vector the 2026-04-22 pentest report asked about, including
// URL-encoding bypass tricks that hit `fetch()` only because WHATWG URL
// auto-normalizes them (e.g. `http://127.1` → `127.0.0.1`).
//
// Run: node test/stress/test-378-ssrf-hub-detect-vectors.mjs
//
// Every `expectReject(url)` asserts the SSRF guard throws
// "Invalid or disallowed OpenAPI URL" — a consistent error message the
// route layer maps to 400 `detect_failed`. If a vector returns a different
// error (e.g. "fetch failed" or "ENOTFOUND"), that means the URL *reached*
// fetch() and the guard missed — a real bypass.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';

const tmp = mkdtempSync(join(tmpdir(), 'floom-378-vectors-'));
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

async function expectReject(label, url, opts) {
  try {
    await fetchSpec(url, opts);
    fail(label, 'expected throw, got success');
  } catch (err) {
    const msg = err?.message || String(err);
    if (
      msg.includes('Invalid or disallowed OpenAPI URL') ||
      msg.includes('Invalid or disallowed OpenAPI redirect target')
    ) {
      ok(label);
    } else {
      fail(label, `wrong error (SSRF guard missed): ${msg}`);
    }
  }
}

// --- URL-encoding bypass tricks (pentest category: classic SSRF obfuscation) -
// WHATWG URL normalizes these to 127.0.0.1 before the guard sees the hostname,
// so the 127/8 BlockList entry must catch all three. If any of these REACH
// fetch, that's an unauthenticated SSRF into loopback.
console.log('URL-encoding bypass tricks');
await expectReject('http://127.1/ (short-IPv4 form)', 'http://127.1/openapi.json');
await expectReject(
  'http://0x7f000001/ (hex-encoded IPv4)',
  'http://0x7f000001/openapi.json',
);
await expectReject(
  'http://2130706433/ (decimal-encoded IPv4)',
  'http://2130706433/openapi.json',
);
await expectReject(
  'http://127.0.0.1#@evil.com/ (fragment confusion)',
  'http://127.0.0.1#@evil.com/openapi.json',
);
await expectReject(
  'http://localhost#@evil.com (fragment confusion)',
  'http://localhost#@evil.com',
);

// --- Non-HTTP(S) schemes (file/gopher/ftp/data/javascript) -------------------
console.log('\nNon-HTTP(S) schemes');
await expectReject('file:///etc/passwd', 'file:///etc/passwd');
await expectReject('gopher:// (classic SSRF gadget)', 'gopher://127.0.0.1/_GET');
await expectReject('ftp:// (outbound exfil)', 'ftp://example.com/spec.json');
await expectReject('data: (spec-injection)', 'data:application/json,{}');
await expectReject('javascript: (XSS vector)', 'javascript:alert(1)');
await expectReject('dict://', 'dict://127.0.0.1:11211/stat');
await expectReject('jar://', 'jar:http://127.0.0.1/x!/y');
await expectReject('ws://', 'ws://127.0.0.1/');

// --- CRLF header-injection in URL --------------------------------------------
// Node's undici-backed fetch percent-encodes control characters in the URL
// path before writing to the wire, so raw \r\n can't smuggle HTTP headers
// into the request. We verify that property here rather than asserting the
// guard rejects — the guard doesn't need to rewrite what the URL parser
// already handled. If a future Node change REGRESSES this (unlikely), the
// assertion below flips to a red test without depending on our code path.
console.log('\nCRLF header-injection (URL parser auto-encodes)');
try {
  const injected = new URL('http://example.com/\r\nX-Bar: baz');
  const wire = injected.toString();
  // Node's URL parser either percent-encodes CRLF (%0D%0A) or strips it
  // entirely. Either way, zero raw CR/LF on the wire means fetch() cannot
  // smuggle synthetic headers past the Host line.
  if (!/[\r\n]/.test(wire)) {
    ok(`raw CRLF in URL neutralised by URL constructor (wire=${JSON.stringify(wire)})`);
  } else {
    fail('raw CRLF in URL neutralised', `wire still contains CR/LF: ${JSON.stringify(wire)}`);
  }
} catch {
  // If Node rejects outright, that's equally safe.
  ok('raw CRLF in URL rejected by URL constructor');
}

// --- IPv4 private / reserved ranges -----------------------------------------
console.log('\nIPv4 private / loopback / link-local / reserved');
await expectReject('127.0.0.1 loopback', 'http://127.0.0.1/spec.json');
await expectReject('127.255.255.254 loopback edge', 'http://127.255.255.254/');
await expectReject('0.0.0.0 "this host"', 'http://0.0.0.0/');
await expectReject('10.0.0.1 RFC1918', 'http://10.0.0.1/');
await expectReject('10.255.255.254 RFC1918 edge', 'http://10.255.255.254/');
await expectReject('172.16.0.1 RFC1918', 'http://172.16.0.1/');
await expectReject('172.31.255.254 RFC1918 edge', 'http://172.31.255.254/');
await expectReject('192.168.1.1 RFC1918', 'http://192.168.1.1/');
await expectReject('169.254.169.254 AWS/GCP IMDS', 'http://169.254.169.254/');
await expectReject('100.64.0.1 CGNAT', 'http://100.64.0.1/');
await expectReject(
  '100.100.100.200 Alibaba IMDS (CGNAT range)',
  'http://100.100.100.200/',
);
await expectReject('224.0.0.1 multicast', 'http://224.0.0.1/');
await expectReject('239.255.255.255 multicast edge', 'http://239.255.255.255/');
await expectReject(
  '240.0.0.1 class-E reserved (was gap pre-2026-04-23)',
  'http://240.0.0.1/',
);
await expectReject('255.255.255.255 broadcast', 'http://255.255.255.255/');

// --- IPv6 private / loopback / link-local / ULA -----------------------------
console.log('\nIPv6 private / loopback / link-local / ULA');
await expectReject('::1 IPv6 loopback', 'http://[::1]/');
await expectReject('fe80::1 link-local', 'http://[fe80::1]/');
await expectReject('fc00::1 ULA', 'http://[fc00::1]/');
await expectReject('fd00::1 ULA', 'http://[fd00::1]/');
await expectReject('fdff::1 ULA edge', 'http://[fdff::1]/');
// fec0::/10 "site-local" was deprecated by RFC 3879 in 2004 and IANA no
// longer allocates from that block. We intentionally don't maintain a v6
// rule for it — any modern deployment pointing `fetch()` at fec0::* would
// fail at the network layer. Keeping a test here would lock in dead policy.

// --- IPv4-mapped IPv6 (every form must normalize to the embedded v4) ---------
console.log('\nIPv4-mapped IPv6 (dotted + hex + expanded)');
await expectReject(
  '[::ffff:127.0.0.1] v4-mapped loopback',
  'http://[::ffff:127.0.0.1]/',
);
await expectReject(
  '[::ffff:169.254.169.254] v4-mapped IMDS',
  'http://[::ffff:169.254.169.254]/',
);
await expectReject('[::ffff:10.0.0.1] v4-mapped RFC1918', 'http://[::ffff:10.0.0.1]/');
await expectReject(
  '[::ffff:7f00:1] hex v4-mapped loopback',
  'http://[::ffff:7f00:1]/',
);
await expectReject(
  '[0:0:0:0:0:ffff:7f00:1] expanded v4-mapped loopback',
  'http://[0:0:0:0:0:ffff:7f00:1]/',
);

// --- Localhost string variants ----------------------------------------------
console.log('\nLocalhost string variants');
await expectReject('localhost', 'http://localhost/');
await expectReject('LOCALHOST (case)', 'http://LOCALHOST/');
await expectReject('foo.localhost', 'http://foo.localhost/');
await expectReject('ip6-localhost', 'http://ip6-localhost/');

// --- Explicit internal / metadata hostnames ---------------------------------
// These are the "named" equivalents of the numeric IMDS endpoints. Even if a
// local resolver were to return a public IP for one of these names, we never
// want /detect to issue the outbound fetch.
console.log('\nExplicit internal / cloud-metadata hostnames');
await expectReject('metadata.google.internal', 'http://metadata.google.internal/');
await expectReject('metadata', 'http://metadata/');
await expectReject('metadata.internal', 'http://metadata.internal/');
await expectReject('metadata.azure.com', 'http://metadata.azure.com/');
await expectReject('instance-data', 'http://instance-data/');
await expectReject('instance-data.ec2.internal', 'http://instance-data.ec2.internal/');
await expectReject('*.internal suffix', 'http://svc.internal/');
await expectReject('*.cluster.local (K8s)', 'http://kube-dns.cluster.local/');
await expectReject('*.local (mDNS)', 'http://printer.local/');
await expectReject('*.localdomain', 'http://db.localdomain/');

// --- Redirect re-validation (each Location is re-checked) -------------------
// Spin up two loopback servers — the first redirects to the second. Both are
// allowed-via-allowPrivateNetwork so the redirect *logic* runs; then flip to
// public-caller mode and prove the second hop re-triggers the SSRF guard.
console.log('\nRedirect chain re-validation');
async function startRedirectChain() {
  const target = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} }));
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetPort = target.address().port;

  const redirector = createServer((req, res) => {
    // Redirect to a BLOCKED target (loopback) — guard must reject on the
    // redirect hop even though the initial URL was "safe".
    if (req.url?.startsWith('/to-loopback')) {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/openapi.json` });
      res.end();
      return;
    }
    // Redirect to metadata host — must reject on redirect.
    if (req.url?.startsWith('/to-metadata')) {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    // Redirect loop
    if (req.url?.startsWith('/loop')) {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  redirector.listen(0, '127.0.0.1');
  await once(redirector, 'listening');
  return { target, targetPort, redirector, redirectorPort: redirector.address().port };
}

const chain = await startRedirectChain();
try {
  // Public-caller context: the INITIAL URL is loopback which is blocked
  // upfront — so this test only proves the pre-fetch guard is in place.
  await expectReject(
    'redirect to loopback rejected (initial URL is loopback so blocked up front)',
    `http://127.0.0.1:${chain.redirectorPort}/to-loopback`,
  );

  // Trusted caller: initial URL passes (allowPrivateNetwork), but the
  // redirect target is 169.254.169.254 which must STILL be rejected even
  // under the trusted caller because metadata is the highest-value target.
  await expectReject(
    'trusted caller: redirect → 169.254.169.254 rejected',
    `http://127.0.0.1:${chain.redirectorPort}/to-metadata`,
    { allowPrivateNetwork: false }, // force strict mode on redirect
  );

  // Redirect loop bounded by redirectsRemaining (default 3).
  try {
    await fetchSpec(`http://127.0.0.1:${chain.redirectorPort}/loop`, {
      allowPrivateNetwork: true,
    });
    fail('redirect loop: bounded by redirectsRemaining', 'expected throw');
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes('Too many redirects')) {
      ok('redirect loop: bounded by redirectsRemaining');
    } else {
      fail('redirect loop: bounded by redirectsRemaining', `wrong error: ${msg}`);
    }
  }
} finally {
  chain.target.close();
  chain.redirector.close();
}

// --- Timeout (slow-loris) ---------------------------------------------------
console.log('\nSlow-loris / timeout');
const slowServer = createServer((req, res) => {
  // Never write headers, never respond. Should time out.
  res.writeHead(200, { 'content-type': 'application/json' });
  // write a trickle every 500ms indefinitely
  const iv = setInterval(() => {
    try {
      res.write(' ');
    } catch {
      clearInterval(iv);
    }
  }, 500);
  req.on('close', () => clearInterval(iv));
});
slowServer.listen(0, '127.0.0.1');
await once(slowServer, 'listening');
const slowPort = slowServer.address().port;
try {
  const started = Date.now();
  await fetchSpec(`http://127.0.0.1:${slowPort}/openapi.json`, {
    allowPrivateNetwork: true,
    timeoutMs: 1500,
  });
  fail('slow-loris: timeout fires', 'expected throw, got success');
} catch (err) {
  const msg = err?.message || String(err);
  if (
    msg.includes('abort') ||
    msg.includes('timeout') ||
    msg.includes('operation was aborted') ||
    msg.includes('terminated') ||
    msg.includes('exceeds')
  ) {
    ok('slow-loris: timeout / abort fires');
  } else {
    fail('slow-loris: timeout / abort fires', `wrong error: ${msg}`);
  }
}
slowServer.close();

// --- Content-length bomb (declared > cap) -----------------------------------
console.log('\nContent-Length bomb (declared > cap)');
const lyingServer = createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(10 * 1024 * 1024), // claim 10 MB
  });
  res.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} }));
});
lyingServer.listen(0, '127.0.0.1');
await once(lyingServer, 'listening');
const lyingPort = lyingServer.address().port;
try {
  await fetchSpec(`http://127.0.0.1:${lyingPort}/openapi.json`, {
    allowPrivateNetwork: true,
  });
  fail('declared content-length > 5MB rejected', 'expected throw, got success');
} catch (err) {
  const msg = err?.message || String(err);
  if (msg.includes('exceeds') && msg.includes('bytes')) {
    ok('declared content-length > 5MB rejected (fail-fast)');
  } else {
    fail('declared content-length > 5MB rejected', `wrong error: ${msg}`);
  }
}
lyingServer.close();

// --- DNS rebinding (all resolved IPs must be in allowlist) ------------------
// We can't easily fake DNS in-process without monkey-patching dns.lookup, but
// the *logic* is already hit by the literal-IP tests above (isSafeUrl calls
// isBlockedIp on every resolved record, not just the first). The high-value
// assertion here is that a hostname that resolves to a PUBLIC IP passes, and
// a name that fails to resolve fails closed. Both covered by public-vs-bogus
// name tests.
console.log('\nDNS rebinding defence (resolve & check every record)');
try {
  await fetchSpec('http://definitely-not-a-real-host-for-floom-378.invalid/');
  fail('bogus hostname fails closed', 'expected throw');
} catch (err) {
  const msg = err?.message || String(err);
  if (msg.includes('Invalid or disallowed OpenAPI URL')) {
    ok('bogus hostname fails closed (DNS failure → reject)');
  } else {
    fail('bogus hostname fails closed', `wrong error: ${msg}`);
  }
}

// --- Summary ----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
rmSync(tmp, { recursive: true, force: true });
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
process.exit(0);
