#!/usr/bin/env node
// Verifies the last Floom-side users mirror writes route through storage
// adapter upserts while preserving the old INSERT ... ON CONFLICT behavior.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-adapters-user-upserts-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.BETTER_AUTH_SECRET = process.env.FLOOM_MASTER_KEY;
process.env.BETTER_AUTH_URL = 'http://localhost:3051';
delete process.env.RESEND_API_KEY;

const { db } = await import('../../apps/server/src/db.ts');
const betterAuth = await import('../../apps/server/src/lib/better-auth.ts');
const { adapters } = await import('../../apps/server/src/adapters/index.ts');
const { resolveUserContext } = await import('../../apps/server/src/services/session.ts');

betterAuth._resetAuthForTests();
await betterAuth.runAuthMigrations();

let passed = 0;
let failed = 0;

function log(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`);
  }
}

function firstCookie(setCookie) {
  return setCookie?.split(';', 1)[0]?.trim() || '';
}

try {
  const email = `user-upsert-${Date.now()}@example.com`;
  const signedUp = await adapters.auth.signUp({
    email,
    password: 'hunter2-hunter2',
    name: 'Adapter User',
  });
  const userId = signedUp.session.user_id;
  const created = db
    .prepare(
      `SELECT id, email, name, auth_provider, auth_subject, image
         FROM users WHERE id = ?`,
    )
    .get(userId);
  log(
    'better-auth hook mirrors users row',
    created?.email === email &&
      created?.name === 'Adapter User' &&
      created?.auth_provider === 'better-auth' &&
      created?.auth_subject === userId &&
      created?.image === null,
    JSON.stringify(created),
  );

  db.prepare(`UPDATE users SET auth_subject = ?, image = ? WHERE id = ?`).run(
    'legacy-subject',
    'old-avatar.png',
    userId,
  );
  const updatedEmail = `updated-${email}`;
  db.prepare(
    `UPDATE "user"
        SET "email" = ?, "name" = ?, "image" = ?, "emailVerified" = 1
      WHERE "id" = ?`,
  ).run(updatedEmail, 'Updated Name', 'new-avatar.png', userId);

  const cookie = firstCookie(signedUp.set_cookie);
  const headers = new Headers({
    cookie: `${cookie}; floom_device=device-user-upsert`,
    host: 'localhost:3051',
  });
  const ctx = {
    req: {
      raw: { headers },
      header(name) {
        return headers.get(name) || undefined;
      },
    },
    header() {},
  };
  const session = await resolveUserContext(ctx);
  const refreshed = db
    .prepare(
      `SELECT id, email, name, auth_provider, auth_subject, image
         FROM users WHERE id = ?`,
    )
    .get(userId);
  log(
    'session resolves signed-in user',
    session.user_id === userId && session.is_authenticated === true,
    JSON.stringify(session),
  );
  log(
    'session upsert refreshes only prior conflict columns',
    refreshed?.email === updatedEmail &&
      refreshed?.name === 'Updated Name' &&
      refreshed?.image === 'new-avatar.png' &&
      refreshed?.auth_provider === 'better-auth' &&
      refreshed?.auth_subject === 'legacy-subject',
    JSON.stringify(refreshed),
  );
} finally {
  try {
    db.close();
  } catch {
    // best effort
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passing, ${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
