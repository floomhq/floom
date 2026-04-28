#!/usr/bin/env node
// Better Auth dynamic baseURL regression:
//
// Social sign-in must derive its callback host from the incoming request
// host so floom.dev and preview.floom.dev do not leak into each other.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-auth-dyn-baseurl-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.BETTER_AUTH_URL = 'https://preview.floom.dev';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-client-secret';
process.env.GITHUB_OAUTH_CLIENT_ID = 'github-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'github-client-secret';

const betterAuth = await import('../../apps/server/dist/lib/better-auth.js');
const { db } = await import('../../apps/server/dist/db.js');

betterAuth._resetAuthForTests();
await betterAuth.runAuthMigrations();
const auth = betterAuth.getAuth();

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

async function socialStart(host, provider = 'google') {
  const req = new Request(`https://${host}/auth/sign-in/social`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host,
      origin: `https://${host}`,
    },
    body: JSON.stringify({ provider, callbackURL: '/me' }),
  });
  const res = await auth.handler(req);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, location: res.headers.get('location') || '' };
}

console.log('Auth dynamic baseURL');

try {
  const prod = await socialStart('floom.dev');
  log('google start on floom.dev -> 200', prod.status === 200, JSON.stringify(prod));
  log(
    'google start on floom.dev uses floom.dev callback host',
    prod.location.includes('redirect_uri=https%3A%2F%2Ffloom.dev%2Fauth%2Fcallback%2Fgoogle') ||
      (prod.json?.url || '').includes(
        'redirect_uri=https%3A%2F%2Ffloom.dev%2Fauth%2Fcallback%2Fgoogle',
      ),
    JSON.stringify(prod),
  );

  const preview = await socialStart('preview.floom.dev');
  log('google start on preview host -> 200', preview.status === 200, JSON.stringify(preview));
  log(
    'google start on preview uses preview callback host',
    preview.location.includes(
      'redirect_uri=https%3A%2F%2Fpreview.floom.dev%2Fauth%2Fcallback%2Fgoogle',
    ) ||
      (preview.json?.url || '').includes(
        'redirect_uri=https%3A%2F%2Fpreview.floom.dev%2Fauth%2Fcallback%2Fgoogle',
      ),
      JSON.stringify(preview),
  );

  const github = await socialStart('floom.dev', 'github');
  log('github start on floom.dev -> 200', github.status === 200, JSON.stringify(github));
  log(
    'github start on floom.dev uses floom.dev callback host',
    github.location.includes('redirect_uri=https%3A%2F%2Ffloom.dev%2Fauth%2Fcallback%2Fgithub') ||
      (github.json?.url || '').includes(
        'redirect_uri=https%3A%2F%2Ffloom.dev%2Fauth%2Fcallback%2Fgithub',
      ),
    JSON.stringify(github),
  );
} finally {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
