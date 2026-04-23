#!/usr/bin/env node
// Pentest LOW #385 regression — `Access-Control-Allow-Credentials: true`
// must only be emitted on the restricted CORS surface AND only when the
// request `Origin` is in the trusted list. This file mirrors the exact
// middleware wiring from apps/server/src/index.ts (`restrictedCors`
// wrapper + `openCors`) using Hono + `hono/cors` directly so it can run
// without a DB / native bindings.
//
// Run: node test/stress/test-security-cors-acac.mjs

const { Hono } = await import(
  '../../apps/server/node_modules/hono/dist/index.js'
);
const { cors } = await import(
  '../../apps/server/node_modules/hono/dist/middleware/cors/index.js'
);

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

const trustedOrigins = [
  'https://app.floom.dev',
  'https://preview.floom.dev',
];

const restrictedCorsInner = cors({
  origin: (origin) => {
    if (!origin) return '';
    return trustedOrigins.includes(origin) ? origin : '';
  },
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
});

// Exact copy of the production wrapper in apps/server/src/index.ts. This
// is the fix for #385: strip ACAC whenever ACAO didn't make it onto the
// response, so untrusted origins never see a dangling `credentials=true`.
const restrictedCors = async (c, next) => {
  const maybeResponse = await restrictedCorsInner(c, next);
  const headers = maybeResponse ? maybeResponse.headers : c.res.headers;
  if (!headers.get('Access-Control-Allow-Origin')) {
    headers.delete('Access-Control-Allow-Credentials');
  }
  return maybeResponse;
};

const openCors = cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'Accept'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
});

// ---- restricted surface ----
const restrictedApp = new Hono();
restrictedApp.use('/api/session/*', restrictedCors);
restrictedApp.get('/api/session/me', (c) => c.json({ ok: true }));

console.log('\n[#385] restricted CORS surface');

{
  const res = await restrictedApp.request('/api/session/me', {
    headers: { origin: 'https://app.floom.dev' },
  });
  log(
    'trusted origin: ACAO echoed',
    res.headers.get('access-control-allow-origin') === 'https://app.floom.dev',
    `got=${res.headers.get('access-control-allow-origin')}`,
  );
  log(
    'trusted origin: ACAC=true',
    res.headers.get('access-control-allow-credentials') === 'true',
  );
}

{
  const res = await restrictedApp.request('/api/session/me', {
    headers: { origin: 'https://preview.floom.dev' },
  });
  log(
    'second trusted origin: ACAO echoed',
    res.headers.get('access-control-allow-origin') === 'https://preview.floom.dev',
  );
  log(
    'second trusted origin: ACAC=true',
    res.headers.get('access-control-allow-credentials') === 'true',
  );
}

{
  const res = await restrictedApp.request('/api/session/me', {
    headers: { origin: 'https://evil.example.com' },
  });
  log(
    'untrusted origin: no ACAO',
    res.headers.get('access-control-allow-origin') === null,
    `got=${res.headers.get('access-control-allow-origin')}`,
  );
  log(
    'untrusted origin: ACAC stripped (pentest LOW #385)',
    res.headers.get('access-control-allow-credentials') === null,
    `got=${res.headers.get('access-control-allow-credentials')}`,
  );
}

{
  const res = await restrictedApp.request('/api/session/me', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://evil.example.com',
      'access-control-request-method': 'GET',
    },
  });
  log(
    'preflight from untrusted origin: no ACAC',
    res.headers.get('access-control-allow-credentials') === null,
    `got=${res.headers.get('access-control-allow-credentials')}`,
  );
}

{
  // No `origin` at all (same-origin request) — should be effectively a
  // no-op; ACAC must not be set.
  const res = await restrictedApp.request('/api/session/me');
  log(
    'same-origin (no Origin header): ACAC not set',
    res.headers.get('access-control-allow-credentials') === null,
    `got=${res.headers.get('access-control-allow-credentials')}`,
  );
}

// ---- public surface ----
const publicApp = new Hono();
publicApp.use('/api/hub/*', openCors);
publicApp.get('/api/hub/ping', (c) => c.json({ ok: true }));

console.log('\n[#385] public CORS surface never sets ACAC');

{
  const res = await publicApp.request('/api/hub/ping', {
    headers: { origin: 'https://anywhere.example.com' },
  });
  log(
    'public endpoint: ACAO=*',
    res.headers.get('access-control-allow-origin') === '*',
  );
  log(
    'public endpoint: ACAC not set',
    res.headers.get('access-control-allow-credentials') === null,
  );
}

{
  const res = await publicApp.request('/api/hub/ping', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://anywhere.example.com',
      'access-control-request-method': 'GET',
    },
  });
  log(
    'public preflight: ACAC not set',
    res.headers.get('access-control-allow-credentials') === null,
  );
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
