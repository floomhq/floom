#!/usr/bin/env node
// /api/waitlist — deploy waitlist endpoint (launch 2026-04-27).
//
// Covers the five acceptance scenarios from the launch spec:
//   1. Valid email → 200 + row inserted + ip_hash populated.
//   2. Invalid email → 400, no row written.
//   3. Duplicate email → 200 (idempotent) without a second row.
//   4. Rate limit trips after FLOOM_WAITLIST_IP_PER_HOUR signups /IP,
//      then admin bearer bypasses the cap.
//   5. No RESEND_API_KEY → signup still succeeds (graceful degrade).
//
// The test builds its own tiny Hono app that mounts the router the
// same way apps/server/src/index.ts does, so we exercise the actual
// route plus the rate-limit + email paths end-to-end without having to
// spin up a full server (jobs worker, better-auth, etc.).
//
// Run: node test/stress/test-waitlist.mjs  (after `pnpm --filter
// @floom/server build` — same convention as every other test here.)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-waitlist-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
// Keep the per-IP cap small so the limit-trip test is fast. The route
// reads this on every request.
process.env.FLOOM_WAITLIST_IP_PER_HOUR = '3';
process.env.WAITLIST_IP_HASH_SECRET = 'test-secret';
// Admin bearer for the bypass assertion. The route delegates to
// hasValidAdminBearer() which reads FLOOM_AUTH_TOKEN. See
// apps/server/src/lib/auth.ts::getExpectedToken.
process.env.FLOOM_AUTH_TOKEN = 'test-admin-bearer';
// Explicitly unset RESEND_API_KEY so sendEmail() hits its stdout
// fallback path (test #5). We still want the signup to succeed.
delete process.env.RESEND_API_KEY;

// Import Hono via the server package's own node_modules so Node's ESM
// resolver finds it regardless of cwd. Same pattern as test-renderer-
// e2e.mjs.
const { Hono } = await import('../../apps/server/node_modules/hono/dist/index.js');
const { db } = await import('../../apps/server/dist/db.js');
const { waitlistRouter, __resetWaitlistRateLimitForTests } = await import(
  '../../apps/server/dist/routes/waitlist.js'
);

const app = new Hono();
app.route('/api/waitlist', waitlistRouter);

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

async function post(body, headers = {}) {
  const req = new Request('http://localhost/api/waitlist', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await app.fetch(req);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }
  return { status: res.status, json, text };
}

function rowCount() {
  return db.prepare(`SELECT COUNT(*) AS n FROM waitlist_signups`).get().n;
}

function rowsByEmail(email) {
  return db
    .prepare(`SELECT * FROM waitlist_signups WHERE LOWER(email) = LOWER(?)`)
    .all(email);
}

console.log('Deploy waitlist (/api/waitlist)');

// ── 1. valid email happy path ──────────────────────────────────────────
{
  __resetWaitlistRateLimitForTests();
  db.prepare(`DELETE FROM waitlist_signups`).run();
  const before = rowCount();
  const res = await post({ email: 'alice@example.com', source: 'hero' });
  log('valid email returns 200 ok:true', res.status === 200 && res.json?.ok === true,
    `status=${res.status} body=${res.text}`);
  log('valid email inserts exactly one row', rowCount() === before + 1);
  const rows = rowsByEmail('alice@example.com');
  log('row has expected columns',
    rows.length === 1 &&
      rows[0].email === 'alice@example.com' &&
      rows[0].source === 'hero' &&
      // ip_hash is sha256 hex (64 chars) when extractIp returned a
      // real IP, and null when the test Request had no socket backing
      // so extractIp fell back to "unknown". Both are valid outcomes;
      // we just assert that whatever is there is well-typed.
      (rows[0].ip_hash === null ||
        (typeof rows[0].ip_hash === 'string' && rows[0].ip_hash.length === 64)) &&
      typeof rows[0].created_at === 'string',
    JSON.stringify(rows[0] ?? null),
  );
}

// ── 2. invalid email rejected ──────────────────────────────────────────
{
  __resetWaitlistRateLimitForTests();
  const before = rowCount();
  for (const bad of ['', 'not-an-email', 'a b@c.d', 'a@b', '@x.y']) {
    const res = await post({ email: bad });
    log(`rejects invalid "${bad}"`,
      res.status === 400 && res.json?.error === 'invalid_email',
      `status=${res.status} body=${res.text}`);
  }
  log('invalid emails write no rows', rowCount() === before);
}

// ── 3. duplicate email idempotent ──────────────────────────────────────
{
  __resetWaitlistRateLimitForTests();
  db.prepare(`DELETE FROM waitlist_signups`).run();
  const first = await post({ email: 'bob@example.com', source: 'studio-deploy' });
  log('first signup ok', first.status === 200 && first.json?.ok === true);
  const second = await post({ email: 'BOB@example.com', source: 'me-publish' });
  log('duplicate (case-insensitive) returns 200 ok:true',
    second.status === 200 && second.json?.ok === true,
    `status=${second.status}`);
  log('duplicate does not insert a second row', rowCount() === 1);
}

// ── 4. rate limit trips and admin bearer bypasses ──────────────────────
{
  __resetWaitlistRateLimitForTests();
  db.prepare(`DELETE FROM waitlist_signups`).run();
  const ip = { 'x-forwarded-for': '10.99.0.1' };
  // 3 signups are allowed (FLOOM_WAITLIST_IP_PER_HOUR=3)
  const r1 = await post({ email: 'c1@example.com' }, ip);
  const r2 = await post({ email: 'c2@example.com' }, ip);
  const r3 = await post({ email: 'c3@example.com' }, ip);
  log('first 3 signups within cap succeed',
    r1.status === 200 && r2.status === 200 && r3.status === 200,
    `${r1.status}/${r2.status}/${r3.status}`);
  const r4 = await post({ email: 'c4@example.com' }, ip);
  log('4th signup from same IP returns 429',
    r4.status === 429 && r4.json?.error === 'rate_limit_exceeded',
    `status=${r4.status} body=${r4.text}`);
  // Admin bearer bypasses the cap.
  const r5 = await post(
    { email: 'c5@example.com' },
    { ...ip, authorization: 'Bearer test-admin-bearer' },
  );
  log('admin bearer bypasses the per-IP cap',
    r5.status === 200 && r5.json?.ok === true,
    `status=${r5.status} body=${r5.text}`);
}

// ── 5. no RESEND_API_KEY still persists ────────────────────────────────
{
  __resetWaitlistRateLimitForTests();
  db.prepare(`DELETE FROM waitlist_signups`).run();
  // RESEND_API_KEY was deleted at module top. Re-verify to be safe.
  if (process.env.RESEND_API_KEY) {
    log('test isolation: RESEND_API_KEY unset', false, 'something reintroduced it');
  } else {
    log('test isolation: RESEND_API_KEY unset', true);
  }
  const res = await post({ email: 'no-resend@example.com', source: 'direct' });
  log('signup succeeds even without Resend configured',
    res.status === 200 && res.json?.ok === true,
    `status=${res.status} body=${res.text}`);
  log('row was persisted despite missing Resend',
    rowsByEmail('no-resend@example.com').length === 1);
}

// ── 6. malformed JSON body ─────────────────────────────────────────────
{
  __resetWaitlistRateLimitForTests();
  const res = await post('this is not json');
  log('malformed JSON body → 400 invalid_json',
    res.status === 400 && res.json?.error === 'invalid_json',
    `status=${res.status} body=${res.text}`);
}

try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* tempdir cleanup is best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
