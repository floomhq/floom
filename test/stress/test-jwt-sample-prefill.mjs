// Stress test for the jwt-decode default pre-fill (#278 follow-up).
//
// Before: `/p/jwt-decode` pre-filled the `token` field with the
// SAMPLE_BY_TYPE fallback "hello floom", which produced "token must
// have three dot-separated segments" on the first click. Federico
// flagged it as "stupid example input". The fix: samplePrefill now
// maps the input NAME "token" (and "jwt") to the standard jwt.io
// sample token. Same value InlineDemo uses on the homepage.

import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const mod = await import(
  pathToFileURL(
    resolve(import.meta.dirname, '../../apps/web/src/lib/onboarding.ts'),
  ).href,
);
const { samplePrefill, SAMPLE_JWT } = mod;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

check('SAMPLE_JWT has exactly three dot-separated segments', () => {
  assert.equal(SAMPLE_JWT.split('.').length, 3);
});

check('SAMPLE_JWT header is the HS256/JWT sample', () => {
  // Base64url-decoded header should be {"alg":"HS256","typ":"JWT"}.
  const [rawHeader] = SAMPLE_JWT.split('.');
  const json = Buffer.from(rawHeader, 'base64').toString('utf8');
  const decoded = JSON.parse(json);
  assert.equal(decoded.alg, 'HS256');
  assert.equal(decoded.typ, 'JWT');
});

check('samplePrefill for token input returns SAMPLE_JWT', () => {
  const out = samplePrefill({ name: 'token', type: 'text' });
  assert.equal(out, SAMPLE_JWT);
});

check('samplePrefill for jwt input returns SAMPLE_JWT', () => {
  const out = samplePrefill({ name: 'jwt', type: 'string' });
  assert.equal(out, SAMPLE_JWT);
});

check('samplePrefill respects manifest-provided default first', () => {
  const out = samplePrefill({
    name: 'token',
    type: 'text',
    default: 'explicit-override',
  });
  assert.equal(out, 'explicit-override');
});

check('samplePrefill for non-jwt input still returns old fallback', () => {
  const out = samplePrefill({ name: 'text', type: 'text' });
  // Still the generic "text → text sentence" mapping.
  assert.equal(out, 'The quick brown fox jumps over the lazy dog.');
});

check('samplePrefill for unknown name + unknown type returns null', () => {
  const out = samplePrefill({ name: 'nosuch', type: 'weirdtype' });
  assert.equal(out, null);
});

if (failed > 0) {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed`);
