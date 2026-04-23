#!/usr/bin/env node
// Issue #388 — progressive back-off for failed /auth/sign-in/email (unit-style
// tests on signin-progressive-delay.ts; run after `pnpm --filter server build`).

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

const mod = await import('../../apps/server/dist/lib/signin-progressive-delay.js');

function jsonRes(status, body) {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

console.log('progressive sign-in delay (#388)');

// ---- schedule: threshold 3 → delays 0,0,0 then 1s,2s,4s,… capped 32s ----
{
  const th = mod.defaultProgressiveDelayThreshold();
  log('default threshold is 3', th === 3);
  log(
    'delays: failures 0-2 → 0',
    mod.computeProgressiveSigninDelayMs(0) === 0 && mod.computeProgressiveSigninDelayMs(2) === 0,
  );
  log('failure 3 → 1s (base 1000)', mod.computeProgressiveSigninDelayMs(3) === 1000);
  log('failure 4 → 2s', mod.computeProgressiveSigninDelayMs(4) === 2000);
  log('failure 5 → 4s', mod.computeProgressiveSigninDelayMs(5) === 4000);
  log('capped at 32s', mod.computeProgressiveSigninDelayMs(50) === 32000);
}

// ---- key: N failures then 4th pre-handler wait ~1s; success resets ----
{
  const key = mod.makeSigninProgressiveKey('prog-test@example.com', '10.0.0.1');
  mod.__resetSigninProgressiveDelayForTests();
  delete process.env.FLOOM_SIGNIN_PROGRESSIVE_DELAY;
  const fail = jsonRes(401, { code: 'INVALID_EMAIL_OR_PASSWORD' });
  const ok = jsonRes(200, { user: { id: '1' } });

  for (let i = 0; i < 3; i++) {
    await mod.applyProgressiveSigninDelayForKey(key);
    await mod.recordSigninProgressiveDelayOutcomeForKey(key, fail);
  }
  const t0 = performance.now();
  await mod.applyProgressiveSigninDelayForKey(key);
  const dSlow = performance.now() - t0;
  log('4th pre-handler delay is substantial', dSlow >= 700, `measured ${Math.round(dSlow)}ms`);
  await mod.recordSigninProgressiveDelayOutcomeForKey(key, fail);

  await mod.applyProgressiveSigninDelayForKey(key);
  await mod.recordSigninProgressiveDelayOutcomeForKey(key, ok);
  const t1 = performance.now();
  await mod.applyProgressiveSigninDelayForKey(key);
  const dFast = performance.now() - t1;
  log('after 200, next apply is not delayed', dFast < 100, `measured ${Math.round(dFast)}ms`);
  await mod.recordSigninProgressiveDelayOutcomeForKey(key, fail);
  mod.__resetSigninProgressiveDelayForTests();
}

// ---- disabled via env: no sleep even with many failures ----
{
  const key = mod.makeSigninProgressiveKey('off@example.com', '10.0.0.2');
  mod.__resetSigninProgressiveDelayForTests();
  process.env.FLOOM_SIGNIN_PROGRESSIVE_DELAY = 'false';
  const fail = jsonRes(401, { code: 'INVALID_EMAIL_OR_PASSWORD' });
  for (let i = 0; i < 10; i++) {
    await mod.applyProgressiveSigninDelayForKey(key);
    await mod.recordSigninProgressiveDelayOutcomeForKey(key, fail);
  }
  const t0 = performance.now();
  await mod.applyProgressiveSigninDelayForKey(key);
  const d = performance.now() - t0;
  log('when disabled, apply does not wait', d < 50, `measured ${Math.round(d)}ms`);
  delete process.env.FLOOM_SIGNIN_PROGRESSIVE_DELAY;
  mod.__resetSigninProgressiveDelayForTests();
}

// ---- EMAIL_NOT_VERIFIED does not move the failure counter ----
{
  const key = mod.makeSigninProgressiveKey('unverified@example.com', '10.0.0.3');
  mod.__resetSigninProgressiveDelayForTests();
  const notVerified = jsonRes(400, { code: 'EMAIL_NOT_VERIFIED' });
  for (let i = 0; i < 5; i++) {
    await mod.applyProgressiveSigninDelayForKey(key);
    await mod.recordSigninProgressiveDelayOutcomeForKey(key, notVerified);
  }
  const t0 = performance.now();
  await mod.applyProgressiveSigninDelayForKey(key);
  const d = performance.now() - t0;
  log('unverified responses do not trigger back-off', d < 50, `measured ${Math.round(d)}ms`);
  mod.__resetSigninProgressiveDelayForTests();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
