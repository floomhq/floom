#!/usr/bin/env node
// Renderer slug safety regression tests.
//
// Background (audit 2026-04-20, `docs/functionality-audit/by-area/fn-17-renderer.md`):
// `GET /renderer/:slug/bundle.js` used to hit
// `path.join(RENDERERS_DIR, `${slug}.js`)` with no validation of `slug`.
// `path.join` normalizes `..`, so a crafted slug could resolve to any
// readable `.js` file on the server filesystem and be served as
// `application/javascript`, unauthenticated (the `/renderer` prefix is
// intentionally outside `globalAuthMiddleware`).
//
// The fix centralizes two checks in `renderer-bundler.ts`:
//   1. `isValidRendererSlug(slug)` — allowlist regex matching the
//      hub-ingest pattern. Rejects dots, slashes, uppercase, percent-
//      encoded sequences, and length > 63.
//   2. Realpath + prefix check on the resolved filesystem path, as
//      defense-in-depth against symlinks planted under RENDERERS_DIR.
//
// This test exercises both.

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-renderer-slug-'));
process.env.DATA_DIR = tmp;

const { isValidRendererSlug, getBundleResult, RENDERERS_DIR } = await import(
  '../../apps/server/src/services/renderer-bundler.ts'
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

console.log('renderer slug safety tests');

// ---- isValidRendererSlug: allowlist ----

const rejectCases = [
  // traversal primitives
  '..',
  '../evil',
  '../../etc/passwd',
  '/etc/passwd',
  '.hidden',
  'foo/bar',
  'foo\\bar',
  // percent-encoded (Hono URL-decodes before matching, but a creator who
  // somehow assembles this string should still lose)
  '%2e%2e',
  '%2fetc%2fpasswd',
  // case + character class
  'DEMO',
  'demo_app', // underscore not allowed
  'demo.app',
  'demo app',
  '-leading-hyphen',
  '',
  // length: 64 chars violates the 63-char cap
  'a' + 'b'.repeat(63),
  // wrong type
  null,
  undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  /** @type {any} */ (123),
];

for (const c of rejectCases) {
  log(
    `isValidRendererSlug rejects ${JSON.stringify(c)}`,
    isValidRendererSlug(/** @type {any} */ (c)) === false,
  );
}

const acceptCases = [
  'demo',
  'demo-app',
  'a',
  '0',
  'a1',
  'json-format',
  'word-count-v2',
  'a' + 'b'.repeat(62), // 63 chars exactly
];

for (const c of acceptCases) {
  log(`isValidRendererSlug accepts ${JSON.stringify(c)}`, isValidRendererSlug(c));
}

// ---- getBundleResult: invalid slugs never hit the filesystem ----
//
// Plant a file at `<DATA_DIR>/evil.js` — note: NOT under RENDERERS_DIR —
// and confirm that a crafted slug cannot coax getBundleResult into
// returning a result that references it. We cover the three slug shapes
// most likely to slip past naive validators:
//   - ".." (would path.join up one level)
//   - "../evil" (same, explicit)
//   - absolute-looking "/evil"

const evilOutside = join(tmp, 'evil.js');
writeFileSync(evilOutside, '// pwned');
writeFileSync(`${evilOutside}.hash`, 'deadbeef00000000');
writeFileSync(`${evilOutside}.shape`, 'text');

log(
  'getBundleResult("..") returns undefined',
  getBundleResult('..') === undefined,
);
log(
  'getBundleResult("../evil") returns undefined',
  getBundleResult('../evil') === undefined,
);
log(
  'getBundleResult("/evil") returns undefined',
  getBundleResult('/evil') === undefined,
);
log(
  'getBundleResult("%2e%2e") returns undefined',
  getBundleResult('%2e%2e') === undefined,
);

// ---- getBundleResult: symlink defense-in-depth ----
//
// Plant a symlink inside RENDERERS_DIR with a syntactically-valid slug
// name, pointing to a file OUTSIDE the dir. Even though the slug passes
// the regex, the realpath check must reject it.

mkdirSync(RENDERERS_DIR, { recursive: true });
const externalTarget = join(tmp, 'external-target.js');
writeFileSync(externalTarget, '// outside RENDERERS_DIR');
writeFileSync(`${externalTarget}.hash`, 'feedface00000000');
writeFileSync(`${externalTarget}.shape`, 'text');

const symlinkName = 'symlink-escape';
const symlinkPath = join(RENDERERS_DIR, `${symlinkName}.js`);
try {
  symlinkSync(externalTarget, symlinkPath);
  log(
    'getBundleResult refuses symlink pointing outside RENDERERS_DIR',
    getBundleResult(symlinkName) === undefined,
  );
} catch (err) {
  // Some environments (Windows, restricted containers) forbid symlink
  // creation. Skip cleanly rather than failing the whole suite.
  log(
    'symlink test skipped (symlink creation unsupported in this env)',
    true,
    err.message,
  );
}

// ---- getBundleResult: legitimate bundle still works ----

const legitBundle = join(RENDERERS_DIR, 'legit.js');
writeFileSync(legitBundle, '// legitimate bundle');
writeFileSync(`${legitBundle}.hash`, 'cafebabe00000000');
writeFileSync(`${legitBundle}.shape`, 'text');

const legitResult = getBundleResult('legit');
log(
  'getBundleResult serves a real bundle with a valid slug',
  legitResult !== undefined &&
    legitResult.slug === 'legit' &&
    legitResult.bundlePath === legitBundle,
);

// ---- cleanup ----
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
