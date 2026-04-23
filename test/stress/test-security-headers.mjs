#!/usr/bin/env node
// Security headers middleware test (GitHub #126).
//
// Verifies the P1 CSP/HSTS/referrer/nosniff middleware applies the
// expected headers to responses, and does NOT clobber the renderer
// frame's own tighter CSP.

const { Hono } = await import(
  '../../apps/server/node_modules/hono/dist/index.js'
);
const { securityHeaders, TOP_LEVEL_CSP, PERMISSIONS_POLICY } = await import(
  '../../apps/server/src/middleware/security.ts'
);

let passed = 0;
let failed = 0;
function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Build a tiny Hono app that mirrors how apps/server/src/index.ts mounts
// the middleware: before any routes.
const app = new Hono();
app.use('*', securityHeaders);
app.get('/landing', (c) => c.html('<p>ok</p>'));
app.get('/api/health', (c) => c.json({ ok: true }));
app.get('/renderer/foo/frame.html', (c) => {
  // Simulate renderer.ts setting its own stricter CSP.
  return new Response('<html></html>', {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    },
  });
});

// Test 1: landing page gets the full top-level CSP.
{
  const res = await app.request('/landing');
  const csp = res.headers.get('content-security-policy') || '';
  log('landing: CSP applied', csp === TOP_LEVEL_CSP, `got=${csp}`);
  log(
    'landing: has default-src self',
    csp.includes("default-src 'self'"),
  );
  log(
    'landing: has script-src self (no unsafe-inline)',
    csp.includes("script-src 'self'") && !csp.includes("script-src 'self' 'unsafe-inline'"),
  );
  log(
    'landing: has frame-ancestors none',
    csp.includes("frame-ancestors 'none'"),
  );
  log(
    'landing: has object-src none',
    csp.includes("object-src 'none'"),
  );
  log(
    'landing: has base-uri self',
    csp.includes("base-uri 'self'"),
  );
  log(
    'landing: has form-action self',
    csp.includes("form-action 'self'"),
  );
  log(
    'landing: HSTS with preload',
    res.headers.get('strict-transport-security') ===
      'max-age=31536000; includeSubDomains; preload',
  );
  log(
    'landing: nosniff',
    res.headers.get('x-content-type-options') === 'nosniff',
  );
  log(
    'landing: referrer policy',
    res.headers.get('referrer-policy') === 'strict-origin-when-cross-origin',
  );

  // Pentest MED #380 — style-src no longer carries 'unsafe-inline'.
  log(
    "landing: style-src has NO 'unsafe-inline' (fallback)",
    /style-src [^;]*'self'/.test(csp) &&
      !/style-src [^;]*'unsafe-inline'/.test(csp),
    `got=${csp}`,
  );
  log(
    'landing: style-src-elem restricts stylesheets',
    csp.includes("style-src-elem 'self' https://fonts.googleapis.com"),
  );
  log(
    "landing: style-src-attr allows inline (React style={{}} compat)",
    csp.includes("style-src-attr 'unsafe-inline'"),
  );

  // Pentest MED #379 — Permissions-Policy + Cross-Origin isolation family.
  log(
    'landing: Permissions-Policy applied',
    res.headers.get('permissions-policy') === PERMISSIONS_POLICY,
    `got=${res.headers.get('permissions-policy')}`,
  );
  log(
    'landing: Permissions-Policy disables camera/mic/geo/FLoC',
    (res.headers.get('permissions-policy') || '').includes('camera=()') &&
      (res.headers.get('permissions-policy') || '').includes('microphone=()') &&
      (res.headers.get('permissions-policy') || '').includes('geolocation=()') &&
      (res.headers.get('permissions-policy') || '').includes(
        'interest-cohort=()',
      ),
  );
  log(
    'landing: Cross-Origin-Opener-Policy = same-origin',
    res.headers.get('cross-origin-opener-policy') === 'same-origin',
  );
  log(
    'landing: Cross-Origin-Resource-Policy = same-site',
    res.headers.get('cross-origin-resource-policy') === 'same-site',
  );
  log(
    'landing: Cross-Origin-Embedder-Policy = credentialless (not require-corp)',
    res.headers.get('cross-origin-embedder-policy') === 'credentialless',
  );
}

// Test 2: API routes also get CSP (safe; browsers ignore on JSON).
{
  const res = await app.request('/api/health');
  log(
    'api: HSTS applied',
    res.headers.get('strict-transport-security') ===
      'max-age=31536000; includeSubDomains; preload',
  );
  log(
    'api: nosniff',
    res.headers.get('x-content-type-options') === 'nosniff',
  );
}

// Test 3: renderer frame keeps its own stricter CSP (not overwritten).
{
  const res = await app.request('/renderer/foo/frame.html');
  const csp = res.headers.get('content-security-policy') || '';
  log(
    'renderer frame: preserves own CSP',
    csp.includes("default-src 'none'"),
    `got=${csp}`,
  );
  log(
    'renderer frame: not overwritten with top-level CSP',
    csp !== TOP_LEVEL_CSP,
  );
  log(
    'renderer frame: still gets HSTS',
    res.headers.get('strict-transport-security') ===
      'max-age=31536000; includeSubDomains; preload',
  );
}

// Test 4 (pentest LOW #383) — route-set Referrer-Policy / HSTS / nosniff wins
// over the middleware default. This is the "single source of truth that
// still respects route overrides" contract.
{
  const routeApp = new Hono();
  routeApp.use('*', securityHeaders);
  routeApp.get('/override', (c) =>
    new Response('ok', {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'Referrer-Policy': 'no-referrer',
        'Strict-Transport-Security': 'max-age=0',
        'X-Content-Type-Options': 'custom-probe',
      },
    }),
  );
  const res = await routeApp.request('/override');
  log(
    'override: Referrer-Policy route value wins',
    res.headers.get('referrer-policy') === 'no-referrer',
    `got=${res.headers.get('referrer-policy')}`,
  );
  log(
    'override: HSTS route value wins',
    res.headers.get('strict-transport-security') === 'max-age=0',
    `got=${res.headers.get('strict-transport-security')}`,
  );
  log(
    'override: nosniff route value wins',
    res.headers.get('x-content-type-options') === 'custom-probe',
    `got=${res.headers.get('x-content-type-options')}`,
  );
  // No comma-joined duplicates from `append`-style header plumbing.
  log(
    'override: Referrer-Policy not comma-joined (no dup)',
    !(res.headers.get('referrer-policy') || '').includes(','),
  );
  log(
    'override: HSTS not comma-joined (no dup)',
    !(res.headers.get('strict-transport-security') || '').includes(','),
  );
}

// Test 5 (pentest LOW #384) — X-Frame-Options is NOT emitted anywhere.
// CSP `frame-ancestors 'none'` supersedes it on every supported browser.
{
  const res1 = await app.request('/landing');
  const res2 = await app.request('/api/health');
  const res3 = await app.request('/renderer/foo/frame.html');
  log(
    'landing: no X-Frame-Options (CSP frame-ancestors supersedes)',
    res1.headers.get('x-frame-options') === null,
    `got=${res1.headers.get('x-frame-options')}`,
  );
  log(
    'api: no X-Frame-Options',
    res2.headers.get('x-frame-options') === null,
  );
  log(
    'renderer frame: no X-Frame-Options',
    res3.headers.get('x-frame-options') === null,
  );
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
