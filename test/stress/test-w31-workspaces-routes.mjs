#!/usr/bin/env node
// W3.1 routes tests. Exercises /api/workspaces and /api/session via the
// exported Hono routers (no server boot). Validates:
//
//   - POST /api/workspaces (create)
//   - GET /api/workspaces (list)
//   - GET /api/workspaces/:id
//   - PATCH /api/workspaces/:id (admin only)
//   - DELETE /api/workspaces/:id (admin only, refuses 'local')
//   - GET /api/workspaces/:id/members
//   - PATCH /api/workspaces/:id/members/:user_id (changeRole)
//   - DELETE /api/workspaces/:id/members/:user_id (removeMember)
//   - POST /api/workspaces/:id/members/invite
//   - POST /api/workspaces/:id/members/accept-invite
//   - GET /api/workspaces/:id/invites
//   - DELETE /api/workspaces/:id/invites/:invite_id
//   - GET /api/session/me
//   - POST /api/session/switch-workspace
//   - Error envelope shape {error, code, details?}
//   - Body validation (Zod)
//   - Cookie minted on first call (W2.1 device cookie shared)
//
// In OSS mode (FLOOM_CLOUD_MODE unset) every call resolves to the synthetic
// local user, so the test patches the sessionContext via an env var below.
// For multi-user scenarios we fall back to the service tests.
//
// Run: node test/stress/test-w31-workspaces-routes.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-w31-ws-routes-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

const { db, DEFAULT_WORKSPACE_ID } = await import(
  '../../apps/server/dist/db.js'
);
const { workspacesRouter, sessionRouter } = await import(
  '../../apps/server/dist/routes/workspaces.js'
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

console.log('W3.1 routes tests');

// ---- helper: request a Hono router with cookie-jar ----
async function fetchRoute(router, method, path, body, cookie) {
  const url = `http://localhost${path}`;
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  if (cookie) {
    init.headers = { ...(init.headers || {}), cookie };
  }
  const req = new Request(url, init);
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

// ---- 1. POST /api/workspaces — happy path ----
let r = await fetchRoute(workspacesRouter, 'POST', '/', {
  name: 'Acme Inc',
});
log('POST /: 201', r.status === 201, `got ${r.status}`);
log('POST /: workspace.id starts with ws_', r.json?.workspace?.id?.startsWith('ws_'));
log('POST /: workspace.slug=acme-inc', r.json?.workspace?.slug === 'acme-inc');
// Security H1 (audit 2026-04-23): wrapped_dek MUST never cross the API
// boundary. It's the AES-wrapped DEK ciphertext — useless without the
// KEK, but still defense-in-depth.
log(
  'POST /: response does NOT include wrapped_dek',
  !('wrapped_dek' in (r.json?.workspace || {})),
);

// capture session cookie for follow-up requests
const setCookie = r.headers.get('set-cookie') || '';
const match = /floom_device=([^;]+)/.exec(setCookie);
const cookie = match ? `floom_device=${match[1]}` : null;
log('POST /: floom_device cookie minted', !!cookie);

const acmeId = r.json.workspace.id;

// ---- 2. POST /: bad body → 400 ----
r = await fetchRoute(workspacesRouter, 'POST', '/', { foo: 'bar' }, cookie);
log('POST / bad body: 400', r.status === 400);
log("POST / bad body: code='invalid_body'", r.json?.code === 'invalid_body');
log('POST / bad body: details present', r.json?.details);

// ---- 3. POST /: non-JSON body → 400 ----
const badReq = new Request('http://localhost/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: 'not json',
});
const badRes = await workspacesRouter.fetch(badReq);
log('POST / non-JSON: 400', badRes.status === 400);

// ---- 4. GET / lists workspaces visible to caller ----
r = await fetchRoute(workspacesRouter, 'GET', '/', undefined, cookie);
log('GET /: 200', r.status === 200);
log('GET /: workspaces is an array', Array.isArray(r.json?.workspaces));
// local user is auto-admin on synthetic 'local' + member of newly-created acme
const slugs = r.json.workspaces.map((w) => w.slug);
log('GET /: includes local', slugs.includes('local'));
log('GET /: includes acme-inc', slugs.includes('acme-inc'));
// Security H1: no wrapped_dek on any workspace in the list.
log(
  'GET /: no workspace exposes wrapped_dek',
  r.json.workspaces.every((w) => !('wrapped_dek' in w)),
);

// ---- 5. GET /:id happy path ----
r = await fetchRoute(workspacesRouter, 'GET', `/${acmeId}`, undefined, cookie);
log('GET /:id: 200', r.status === 200);
log('GET /:id: name matches', r.json?.workspace?.name === 'Acme Inc');
log(
  'GET /:id: response does NOT include wrapped_dek',
  !('wrapped_dek' in (r.json?.workspace || {})),
);

// ---- 6. GET /:id missing → 404 ----
r = await fetchRoute(
  workspacesRouter,
  'GET',
  '/ws_nonexistent',
  undefined,
  cookie,
);
log('GET /:id missing: 404', r.status === 404);
log("GET /:id missing: code='workspace_not_found'", r.json?.code === 'workspace_not_found');

// ---- 7. PATCH /:id updates name ----
r = await fetchRoute(
  workspacesRouter,
  'PATCH',
  `/${acmeId}`,
  { name: 'Acme Renamed' },
  cookie,
);
log('PATCH /:id: 200', r.status === 200);
log('PATCH /:id: name applied', r.json?.workspace?.name === 'Acme Renamed');

// ---- 8. PATCH /:id with empty body → 400 ----
r = await fetchRoute(workspacesRouter, 'PATCH', `/${acmeId}`, {}, cookie);
log('PATCH /:id empty body: 400', r.status === 400);

// ---- 9. PATCH /:id missing → uses NotAMemberError (403) before NotFound ----
// The synthetic local user is admin only on 'local'; for other workspaces
// they are not-a-member. So patching a nonexistent ws may return 403 (not
// 404) because assertRole runs first. Either is acceptable; we just check
// it's an error.
r = await fetchRoute(
  workspacesRouter,
  'PATCH',
  '/ws_missing',
  { name: 'x' },
  cookie,
);
log('PATCH /:id missing: error', r.status >= 400);

// ---- 10. DELETE 'local' refused ----
r = await fetchRoute(
  workspacesRouter,
  'DELETE',
  `/${DEFAULT_WORKSPACE_ID}`,
  undefined,
  cookie,
);
log('DELETE /local: 500 (refusal)', r.status === 500);
log(
  "DELETE /local: error mentions synthetic local",
  /local/.test(r.json?.error || ''),
);

// ---- 11. GET /:id/members ----
r = await fetchRoute(
  workspacesRouter,
  'GET',
  `/${acmeId}/members`,
  undefined,
  cookie,
);
log('GET /:id/members: 200', r.status === 200);
log('GET /:id/members: 1 member (local)', r.json?.members?.length === 1);
log(
  'GET /:id/members: local is admin',
  r.json?.members?.[0]?.user_id === 'local' &&
    r.json?.members?.[0]?.role === 'admin',
);

// ---- 12. POST /:id/members/invite — happy path ----
r = await fetchRoute(
  workspacesRouter,
  'POST',
  `/${acmeId}/members/invite`,
  { email: 'jannik@floom.dev', role: 'editor' },
  cookie,
);
log('POST /invite: 201', r.status === 201, `got ${r.status}`);
log('POST /invite: invite returned', !!r.json?.invite);
log('POST /invite: accept_url returned', typeof r.json?.accept_url === 'string');
log('POST /invite: status pending', r.json?.invite?.status === 'pending');
const inviteId = r.json.invite.id;
const inviteToken = r.json.invite.token;

// ---- 13. POST /:id/members/invite — bad body ----
r = await fetchRoute(
  workspacesRouter,
  'POST',
  `/${acmeId}/members/invite`,
  { email: 'not-an-email' },
  cookie,
);
log('POST /invite bad email: 400', r.status === 400);

// ---- 14. GET /:id/invites lists pending ----
r = await fetchRoute(
  workspacesRouter,
  'GET',
  `/${acmeId}/invites`,
  undefined,
  cookie,
);
log('GET /:id/invites: 200', r.status === 200);
log(
  'GET /:id/invites: 1 pending',
  r.json?.invites?.length === 1 && r.json.invites[0].status === 'pending',
);

// ---- 15. DELETE /:id/invites/:invite_id revokes ----
r = await fetchRoute(
  workspacesRouter,
  'DELETE',
  `/${acmeId}/invites/${inviteId}`,
  undefined,
  cookie,
);
log('DELETE /invites/:id: 200', r.status === 200);
const after = db
  .prepare('SELECT status FROM workspace_invites WHERE id = ?')
  .get(inviteId);
log('DELETE /invites/:id: status=revoked', after.status === 'revoked');

// ---- 16. POST /:id/members/accept-invite — synthetic local user is
// not authenticated, so the service refuses with "must be authenticated".
// In Cloud mode the same call would route to InviteNotFoundError for a bogus
// token (because the user IS authenticated). Here we just check that the
// route surfaces an error envelope, not a stack trace.
r = await fetchRoute(
  workspacesRouter,
  'POST',
  `/${acmeId}/members/accept-invite`,
  { token: 'totally-bogus-token-1234' },
  cookie,
);
log('POST /accept-invite (OSS unauth): 500', r.status === 500);
log(
  "POST /accept-invite (OSS unauth): error envelope shape",
  typeof r.json?.error === 'string' && typeof r.json?.code === 'string',
);

// ---- 17. POST /:id/members/accept-invite — bad body ----
r = await fetchRoute(
  workspacesRouter,
  'POST',
  `/${acmeId}/members/accept-invite`,
  { wrong: 'shape' },
  cookie,
);
log('POST /accept-invite bad body: 400', r.status === 400);

// ---- 18. PATCH /:id/members/:user_id — bad role ----
r = await fetchRoute(
  workspacesRouter,
  'PATCH',
  `/${acmeId}/members/local`,
  { role: 'BadRole' },
  cookie,
);
log('PATCH /members/:id bad role: 400', r.status === 400);

// ---- 19. DELETE /:id/members/:user_id — last admin guard ----
r = await fetchRoute(
  workspacesRouter,
  'DELETE',
  `/${acmeId}/members/local`,
  undefined,
  cookie,
);
log('DELETE /members/:id last admin: 409', r.status === 409);
log("DELETE /members/:id last admin: code='last_admin'", r.json?.code === 'last_admin');

// ---- 20. GET /api/session/me — happy path ----
r = await fetchRoute(sessionRouter, 'GET', '/me', undefined, cookie);
log('GET /me: 200', r.status === 200);
log('GET /me: user.id=local', r.json?.user?.id === 'local');
log('GET /me: user.is_local=true', r.json?.user?.is_local === true);
log('GET /me: cloud_mode=false (OSS)', r.json?.cloud_mode === false);
log('GET /me: workspaces array present', Array.isArray(r.json?.workspaces));
log(
  'GET /me: active_workspace populated',
  !!r.json?.active_workspace?.id && !!r.json?.active_workspace?.role,
);

// ---- 21. POST /api/session/switch-workspace — happy path ----
r = await fetchRoute(
  sessionRouter,
  'POST',
  '/switch-workspace',
  { workspace_id: acmeId },
  cookie,
);
// In OSS the synthetic local user is always admin on 'local' but on
// non-local workspaces only if they're a member. We added local as the
// admin of acmeId via create() above, so this should be 200.
log('POST /switch-workspace: 200', r.status === 200);
log('POST /switch-workspace: ok=true', r.json?.ok === true);

// ---- 22. POST /switch-workspace — bad body ----
r = await fetchRoute(
  sessionRouter,
  'POST',
  '/switch-workspace',
  { foo: 'bar' },
  cookie,
);
log('POST /switch-workspace bad body: 400', r.status === 400);

// ---- 23. POST /switch-workspace — non-member (force a fresh ws bob) ----
// Manually insert a workspace the local user is NOT in.
db.prepare(
  `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'cloud_free')`,
).run('ws_other', 'other', 'Other');
r = await fetchRoute(
  sessionRouter,
  'POST',
  '/switch-workspace',
  { workspace_id: 'ws_other' },
  cookie,
);
log('POST /switch-workspace non-member: 403', r.status === 403);
log("POST /switch-workspace non-member: code='not_a_member'", r.json?.code === 'not_a_member');

// ---- 24. session cookie attributes ----
log('cookie: HttpOnly', setCookie.includes('HttpOnly'));
log('cookie: SameSite=Lax', setCookie.includes('SameSite=Lax'));

// ---- cleanup ----
db.close();
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
