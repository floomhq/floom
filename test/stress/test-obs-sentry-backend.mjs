#!/usr/bin/env node
// Contract tests for the backend Sentry helper.
//
// The helper is wrapped around `@sentry/node` so Floom can ship without
// a DSN (self-host default). The hard requirement from #311: the preview
// image must boot cleanly with SENTRY_SERVER_DSN unset, and `captureServerError`
// must be safe to call from the error handler regardless.
//
// We test:
//   1. initSentry() is a no-op (sentryEnabled() stays false) when
//      SENTRY_SERVER_DSN is not set.
//   2. captureServerError() does NOT throw when Sentry is disabled.
//   3. The secret scrubber redacts password/token/api-key/authorization/
//      secret/cookie keys at any nesting depth (contract for beforeSend).
//
// Run: node test/stress/test-obs-sentry-backend.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SENTRY_SRC = join(REPO_ROOT, 'apps/server/src/lib/sentry.ts');

let passed = 0;
let failed = 0;
const log = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
};

function runCase(envOverrides, scriptBody) {
  const tmp = mkdtempSync(join(tmpdir(), 'floom-sentry-'));
  const runner = join(tmp, 'runner.mjs');
  writeFileSync(
    runner,
    `
import { initSentry, sentryEnabled, captureServerError, __testing } from ${JSON.stringify(SENTRY_SRC)};

const result = { threw: false, error: null };
try {
${scriptBody}
} catch (err) {
  result.threw = true;
  result.error = err?.message || String(err);
}
process.stdout.write(JSON.stringify({ enabled: sentryEnabled(), ...result, scrub: (()=>{
  const obj = { password: 'p', safe: 'ok', nested: { api_key: 'x', plain: 'y' }, list: [{ Authorization: 'Bearer z', normal: 1 }] };
  __testing.scrubSecrets(obj);
  return obj;
})()}));
`,
  );
  const env = { ...process.env, ...envOverrides };
  // Scope-scrub: explicitly delete SENTRY_SERVER_DSN if the caller asked to unset.
  if (envOverrides.SENTRY_SERVER_DSN === undefined) delete env.SENTRY_SERVER_DSN;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', runner],
    { env, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `runner failed: status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

// ---------------------------------------------------------------------------
// 1. No-op when DSN absent — the preview-self-host case.
// ---------------------------------------------------------------------------
const unset = runCase(
  { SENTRY_SERVER_DSN: undefined },
  `
initSentry();
captureServerError(new Error('boom'), { path: '/api/run' });
`,
);
log(
  'sentryEnabled() = false when SENTRY_SERVER_DSN is unset',
  unset.enabled === false,
  `enabled=${unset.enabled}`,
);
log(
  'captureServerError() does not throw when Sentry is disabled',
  unset.threw === false,
  unset.error,
);
log(
  'initSentry() returns cleanly (no throw) without a DSN',
  unset.threw === false,
);

// ---------------------------------------------------------------------------
// 2. Secret scrubber — the contract beforeSend relies on.
// ---------------------------------------------------------------------------
const scrubbed = unset.scrub;
log(
  'scrubber redacts top-level `password`',
  scrubbed.password === '[Scrubbed]',
);
log('scrubber keeps non-secret top-level keys', scrubbed.safe === 'ok');
log(
  'scrubber redacts nested `api_key`',
  scrubbed.nested.api_key === '[Scrubbed]',
);
log(
  'scrubber keeps non-secret nested keys',
  scrubbed.nested.plain === 'y',
);
log(
  'scrubber redacts `Authorization` inside arrays',
  scrubbed.list[0].Authorization === '[Scrubbed]',
);
log(
  'scrubber preserves non-secret siblings in arrays',
  scrubbed.list[0].normal === 1,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
