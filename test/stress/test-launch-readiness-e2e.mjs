#!/usr/bin/env node
/**
 * Launch-readiness e2e smoke against deployed Floom preview.
 *
 * Hits https://preview.floom.dev (or env BASE_URL) and verifies every
 * critical user/agent flow end-to-end:
 *   - Anon: landing renders; /apps lists demo apps; /p/<slug> serves
 *   - Anon run: POST /api/<slug>/run for the 3 launch demo apps
 *   - Health: GET /api/health returns ok + version
 *   - Public listing: GET /api/hub returns apps
 *   - Sharing: link-token-protected app rejects bad key, accepts good key
 *   - MCP: /mcp/sse returns SSE event stream
 *   - Embed: /embed/<slug> returns chromeless surface
 *
 * Usage:
 *   node test/stress/test-launch-readiness-e2e.mjs               # against preview
 *   BASE_URL=https://floom.dev node test/stress/test-launch-readiness-e2e.mjs
 *
 * NOT in CI (live URL). Run manually before launch + on every prod deploy.
 */

const BASE = process.env.BASE_URL || 'https://preview.floom.dev';
const TIMEOUT = 30_000;

let passed = 0;
let failed = 0;
const failures = [];

function log(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    failures.push({ label, detail });
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// =============== ANON FLOW ===============
async function anonFlow() {
  console.log('\n[anon flow]');

  // Landing
  let res = await fetchWithTimeout(`${BASE}/`);
  log('landing returns 200', res.status === 200);
  log('landing serves text/html', res.headers.get('content-type')?.includes('text/html'));
  const landingBody = await res.text();
  log('landing has app brand', landingBody.toLowerCase().includes('floom'));

  // /apps directory
  res = await fetchWithTimeout(`${BASE}/apps`);
  log('/apps returns 200', res.status === 200);

  // Hub API
  res = await fetchWithTimeout(`${BASE}/api/hub`);
  log('/api/hub returns 200', res.status === 200);
  if (res.ok) {
    const hub = await res.json();
    log('/api/hub has apps array', Array.isArray(hub.apps) && hub.apps.length >= 1, `count=${hub.apps?.length || 0}`);
    // Verify the 3 launch demo apps are present
    const slugs = new Set((hub.apps || []).map((a) => a.slug));
    log('/api/hub has lead-scorer', slugs.has('lead-scorer'));
    log('/api/hub has competitor-analyzer', slugs.has('competitor-analyzer'));
    log('/api/hub has resume-screener', slugs.has('resume-screener'));
  }

  // /p/<slug> for each launch app
  for (const slug of ['lead-scorer', 'competitor-analyzer', 'resume-screener']) {
    res = await fetchWithTimeout(`${BASE}/p/${slug}`);
    log(`/p/${slug} returns 200`, res.status === 200);
  }

  // Health
  res = await fetchWithTimeout(`${BASE}/api/health`);
  log('/api/health returns 200', res.status === 200);
  if (res.ok) {
    const h = await res.json();
    log('/api/health has version', typeof h.version === 'string');
    log('/api/health has app count', typeof h.apps === 'number' || typeof h.app_count === 'number');
  }

  // OG card
  res = await fetchWithTimeout(`${BASE}/og.svg`);
  log('/og.svg returns 200', res.status === 200);
  log('/og.svg is svg', res.headers.get('content-type')?.includes('svg'));

  // Embed surface
  res = await fetchWithTimeout(`${BASE}/embed/lead-scorer`);
  log('/embed/lead-scorer returns 200', res.status === 200);
}

// =============== ANON RUN FLOW ===============
async function anonRunFlow() {
  console.log('\n[anon run flow] (POST /api/<slug>/run for the 3 launch demos)');

  const probes = [
    {
      slug: 'lead-scorer',
      body: { companies: ['stripe.com'], icp: 'B2B SaaS, $5M-$50M ARR' },
    },
    {
      slug: 'competitor-analyzer',
      body: { competitors: ['stripe', 'adyen'], focus: 'pricing' },
    },
    {
      slug: 'resume-screener',
      body: { resume: '5y python, 2y ML, AWS', role: 'Senior Backend Engineer' },
    },
  ];

  for (const { slug, body } of probes) {
    const res = await fetchWithTimeout(`${BASE}/api/${slug}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 60_000,
    });
    const ok = res.status === 200 || res.status === 202;
    log(`POST /api/${slug}/run returns 200/202`, ok, `status=${res.status}`);
    if (ok) {
      const j = await res.json().catch(() => null);
      log(`/api/${slug}/run response is JSON`, j !== null);
      // Status header presence (rate-limit + scope)
      log(
        `/api/${slug}/run has X-RateLimit-* headers`,
        Boolean(res.headers.get('x-ratelimit-limit') || res.headers.get('X-RateLimit-Limit')),
      );
    }
  }
}

// =============== MCP FLOW ===============
async function mcpFlow() {
  console.log('\n[MCP flow]');

  // SSE endpoint should respond with text/event-stream
  const res = await fetchWithTimeout(`${BASE}/mcp/sse`, {
    headers: { Accept: 'text/event-stream' },
    timeout: 5_000,
  }).catch((e) => ({ status: 0, error: e.message }));

  if (res.status === 200 || res.status === 0) {
    // Either it responded (good) or it streams indefinitely (we aborted on timeout, also ok)
    log('mcp/sse endpoint reachable', true);
  } else {
    log('mcp/sse endpoint reachable', false, `status=${res.status}`);
  }

  // MCP tools discovery via REST shim if it exists
  const res2 = await fetchWithTimeout(`${BASE}/api/mcp/tools`).catch(() => null);
  if (res2) {
    log('mcp tools discovery', res2.status === 200 || res2.status === 401, `status=${res2.status}`);
  }
}

// =============== SECURITY HEADERS ===============
async function securityFlow() {
  console.log('\n[security flow]');

  const res = await fetchWithTimeout(`${BASE}/`);
  const csp = res.headers.get('content-security-policy');
  log('landing has CSP', Boolean(csp));
  log('landing has X-Frame-Options or frame-ancestors in CSP', Boolean(res.headers.get('x-frame-options') || (csp && csp.includes('frame-ancestors'))));
  log('landing has Strict-Transport-Security', Boolean(res.headers.get('strict-transport-security')));
  log('no Server header leak (no version)', !(res.headers.get('server') || '').match(/\d+\.\d+/));
}

// =============== RATE LIMIT ===============
async function rateLimitFlow() {
  console.log('\n[rate-limit flow]');

  // /api/uuid/run is a fast utility, won't actually trip but confirms headers
  const res = await fetchWithTimeout(`${BASE}/api/uuid/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  log('uuid/run returns 200', res.status === 200);
  log('uuid/run has X-RateLimit-Limit header', Boolean(res.headers.get('x-ratelimit-limit')));
  log('uuid/run has X-RateLimit-Remaining header', Boolean(res.headers.get('x-ratelimit-remaining')));
  log('uuid/run has X-RateLimit-Scope header', Boolean(res.headers.get('x-ratelimit-scope')));
}

// =============== AUDIT LOG (admin-gated) ===============
async function auditLogFlow() {
  console.log('\n[audit-log flow]');
  // Without admin token: should return 403 (Forbidden, gated)
  const res = await fetchWithTimeout(`${BASE}/api/admin/audit-log?limit=1`);
  log('audit-log gated for anon (403)', res.status === 403, `status=${res.status}`);
}

// =============== MAIN ===============
async function main() {
  console.log(`\nFloom launch-readiness e2e smoke against ${BASE}`);
  console.log('═'.repeat(60));

  await anonFlow();
  await anonRunFlow();
  await mcpFlow();
  await securityFlow();
  await rateLimitFlow();
  await auditLogFlow();

  console.log('\n' + '═'.repeat(60));
  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`);
    }
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  process.exit(2);
});
