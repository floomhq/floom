#!/usr/bin/env node
// Regression coverage for the P1/P2 security-headers cluster PR — the
// slice that depends on the DB + Better Auth runtime.
//
//   - #382  session cookie SameSite=Strict
//   - #386  session cookie name is opaque (no better-auth branding)
//   - #387  /api/session/me returns role='guest' (not 'admin') for
//           unauthenticated cloud-mode visitors
//
// Pure-Hono coverage for #385 (ACAC scoping) lives in
// test-security-cors-acac.mjs so it can run locally without the native
// better-sqlite3 binding.
//
// #379/#380/#383/#384 coverage lives in test-security-headers.mjs.
//
// Run: node test/stress/test-security-cluster-p1p2.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-sec-cluster-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.BETTER_AUTH_URL = 'http://localhost:3051';

const { DEFAULT_USER_ID } = await import(
  '../../apps/server/dist/db.js'
);
const betterAuth = await import('../../apps/server/dist/lib/better-auth.js');
const { sessionRouter } = await import(
  '../../apps/server/dist/routes/workspaces.js'
);

betterAuth._resetAuthForTests();
await betterAuth.runAuthMigrations();

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

async function fetchRoute(router, method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const req = new Request(`http://localhost${path}`, init);
  const res = await router.fetch(req);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json, text, headers: res.headers };
}

// =====================================================================
// #386 — better-auth session cookie ships under `fsid` / `__Secure-fsid`
// (opaque, no framework branding).
// =====================================================================
console.log('\n[#386] better-auth session cookie is opaque');

{
  const auth = betterAuth.getAuth();
  const ctx = await auth.$context;
  const cookieName = ctx?.authCookies?.sessionToken?.name;
  log(
    'Better Auth session_token cookie name is the opaque `fsid` / `__Secure-fsid`',
    cookieName === '__Secure-fsid' || cookieName === 'fsid',
    `got=${cookieName}`,
  );
  log(
    'session cookie name does NOT leak `better-auth` / `session_token`',
    typeof cookieName === 'string' &&
      !cookieName.includes('better-auth') &&
      !cookieName.includes('session_token') &&
      !cookieName.includes('floom.session'),
    `got=${cookieName}`,
  );
}

// =====================================================================
// #382 — cookie SameSite defaults are Strict (session) / Lax (oauth state).
// We read the configured attribute map directly from the Better Auth
// context so the test is deterministic without a full OAuth round-trip.
// =====================================================================
console.log('\n[#382] cookie SameSite hardening');

{
  const auth = betterAuth.getAuth();
  const ctx = await auth.$context;
  const cookies = ctx?.authCookies || {};
  const sessionAttrs = cookies.sessionToken?.attributes || {};
  // `state` / `oauth_state` are short-lived, created on demand via
  // `createAuthCookie(name)` rather than living in the static authCookies
  // map. Use that factory to read the merged attributes.
  const stateAttrs =
    ctx?.createAuthCookie?.('state')?.attributes || {};
  const oauthStateAttrs =
    ctx?.createAuthCookie?.('oauth_state')?.attributes || {};

  log(
    'session cookie SameSite=strict',
    (sessionAttrs.sameSite || '').toLowerCase() === 'strict',
    `got=${sessionAttrs.sameSite}`,
  );
  log(
    'session cookie httpOnly=true',
    sessionAttrs.httpOnly === true,
  );
  log(
    'session cookie secure=true',
    sessionAttrs.secure === true,
  );
  // OAuth state cookies must stay Lax — the provider->Floom 302 callback
  // cannot carry a Strict cookie cross-site, and SameSite=Strict there
  // would break sign-in completely.
  log(
    'OAuth `state` cookie stays SameSite=lax (callback compat)',
    (stateAttrs.sameSite || '').toLowerCase() === 'lax',
    `got=${stateAttrs.sameSite}`,
  );
  log(
    'OAuth `oauth_state` cookie stays SameSite=lax',
    (oauthStateAttrs.sameSite || '').toLowerCase() === 'lax',
    `got=${oauthStateAttrs.sameSite}`,
  );
}

// =====================================================================
// #387 — guest sessions (unauthenticated, cloud mode) return
// `role: 'guest'` with an empty workspace list.
// =====================================================================
console.log('\n[#387] guest role not admin');

{
  // Force Better Auth getSession() to always return null so the session
  // resolver falls through to the synthetic guest branch.
  betterAuth._resetAuthForTests();
  await betterAuth.runAuthMigrations();
  const auth = betterAuth.getAuth();
  auth.api.getSession = async () => null;

  const res = await fetchRoute(sessionRouter, 'GET', '/me');
  log('GET /api/session/me: status 200', res.status === 200, `got ${res.status}`);
  log(
    'guest: cloud_mode=true echoed',
    res.json?.cloud_mode === true,
  );
  log(
    'guest: user.is_local=true (synthetic local user)',
    res.json?.user?.is_local === true,
  );
  log(
    'guest: active_workspace.role === "guest" (NOT "admin")',
    res.json?.active_workspace?.role === 'guest',
    `got=${res.json?.active_workspace?.role}`,
  );
  log(
    'guest: workspaces list is empty',
    Array.isArray(res.json?.workspaces) && res.json.workspaces.length === 0,
    `got len=${res.json?.workspaces?.length}`,
  );

  // Sanity: an authenticated call (simulated via getSession stub) gets a
  // real role back — confirming the guest branch doesn't swallow real
  // membership roles.
  auth.api.getSession = async () => ({
    user: { id: DEFAULT_USER_ID, email: 'auth@example.com' },
    session: { token: 'fake-token', userId: DEFAULT_USER_ID },
  });
  const res2 = await fetchRoute(sessionRouter, 'GET', '/me');
  log(
    'authenticated call: role is a real membership role (admin/editor/viewer)',
    ['admin', 'editor', 'viewer'].includes(res2.json?.active_workspace?.role),
    `got=${res2.json?.active_workspace?.role}`,
  );
}

// ---- cleanup ----
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
