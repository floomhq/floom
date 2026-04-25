#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) {
      out[arg.slice(2)] = 'true';
      continue;
    }
    out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function fail(message, details = undefined) {
  console.error(`[repro-765] FAIL: ${message}`);
  if (details !== undefined) {
    console.error(
      JSON.stringify(details, null, 2),
    );
  }
  process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const dataDir = resolve(repoRoot, args.dataDir || process.env.DATA_DIR || 'data');
const dbPath = join(dataDir, 'floom-chat.db');
const baseUrl = args.baseUrl || process.env.FLOOM_REPRO_BASE_URL || 'http://localhost:3051';
const email =
  args.email ||
  `repro-765-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
const password = args.password || 'DupPass!123';

process.env.DATA_DIR = dataDir;
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.FLOOM_DISABLE_JOB_WORKER = process.env.FLOOM_DISABLE_JOB_WORKER || 'true';
process.env.BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET ||
  'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(16) + 'd'.repeat(16);
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || baseUrl;

if (!existsSync(resolve(repoRoot, 'apps/server/dist/index.js'))) {
  fail(
    'apps/server/dist is missing. Build first: pnpm --filter @floom/server build',
  );
}

const { db } = await import('../../apps/server/dist/db.js');
const betterAuth = await import('../../apps/server/dist/lib/better-auth.js');
const authResponse = await import('../../apps/server/dist/lib/auth-response.js');

async function callSignUp(name) {
  const body = {
    email,
    password,
    name,
    callbackURL: `${baseUrl}/after-verify`,
  };
  const req = new Request(`${baseUrl}/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await auth.handler(req);
  const res = await authResponse.sanitizeAuthResponse(req, raw);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Keep raw text for diagnostics.
  }
  return {
    status: res.status,
    text,
    json,
  };
}

let auth;
try {
  betterAuth._resetAuthForTests();
  await betterAuth.runAuthMigrations();
  auth = betterAuth.getAuth();
  if (!auth) {
    fail('Better Auth did not initialize (FLOOM_CLOUD_MODE=true expected).');
  }
  if (!auth) process.exit(1);

  const first = await callSignUp('dup-1');
  const second = await callSignUp('dup-2');

  const authRows = db
    .prepare(
      `SELECT id, email, emailVerified, createdAt, updatedAt
         FROM "user"
        WHERE lower(email) = lower(?)
        ORDER BY createdAt ASC`,
    )
    .all(email);

  const mirroredRows = db
    .prepare(
      `SELECT id, email, auth_provider, auth_subject, created_at
         FROM users
        WHERE lower(email) = lower(?)
        ORDER BY created_at ASC`,
    )
    .all(email);

  const firstUserId = first.json?.user?.id || null;
  const secondUserId = second.json?.user?.id || null;

  const duplicateRejected = second.status === 409 || second.status === 422;
  const sameUserId = firstUserId && secondUserId && firstUserId === secondUserId;
  const syntheticIdOnly =
    second.status >= 200 &&
    second.status < 300 &&
    firstUserId &&
    secondUserId &&
    firstUserId !== secondUserId &&
    authRows.length === 1;

  if (first.status !== 200) {
    fail('First sign-up did not return 200.', { first });
    process.exit(1);
  }

  if (authRows.length !== 1) {
    fail('Auth table contains duplicate rows for the same email.', { email, authRows });
    process.exit(1);
  }

  if (mirroredRows.length > 1) {
    fail('Mirrored users table contains duplicate rows for the same email.', {
      email,
      mirroredRows,
    });
    process.exit(1);
  }

  // Issue request asks us to accept either a conflict status or an idempotent
  // user id. Better Auth v1.6.3 may return a synthetic user id while still
  // preserving a single DB row (generic duplicate branch).
  if (!duplicateRejected && !sameUserId && !syntheticIdOnly) {
    fail('Second sign-up behavior is not in an accepted safe shape.', {
      first,
      second,
      email,
      authRows,
      mirroredRows,
    });
    process.exit(1);
  }

  console.log('[repro-765] PASS');
  console.log(
    JSON.stringify(
      {
        email,
        dbPath,
        first: {
          status: first.status,
          userId: firstUserId,
          email: first.json?.user?.email || null,
          emailVerified: first.json?.user?.emailVerified ?? null,
        },
        second: {
          status: second.status,
          userId: secondUserId,
          email: second.json?.user?.email || null,
          emailVerified: second.json?.user?.emailVerified ?? null,
        },
        acceptedMode: duplicateRejected
          ? 'duplicate_rejected'
          : sameUserId
            ? 'idempotent_same_user_id'
            : 'synthetic_duplicate_response_single_row',
        authUserRowCount: authRows.length,
        mirroredUserRowCount: mirroredRows.length,
        authRows,
        mirroredRows,
      },
      null,
      2,
    ),
  );
} catch (err) {
  fail('Unexpected error during repro.', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : null,
  });
  process.exit(1);
} finally {
  try {
    db.close();
  } catch {
    // Ignore close errors.
  }
}
