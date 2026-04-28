#!/usr/bin/env node
// BYOK gate library: launch-week "5 free runs per IP per 24h, then
// bring-your-own Gemini key" rule for competitor-lens /
// ai-readiness-audit / pitch-coach.
//
// Run: node test/stress/test-byok-gate.mjs

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

const mod = await import('../../apps/server/dist/lib/byok-gate.js');

console.log('BYOK gate library');

const primarySlug = 'competitor-lens';
const secondarySlug = 'ai-readiness-audit';
const tertiarySlug = 'pitch-coach';

// 1. Slug membership list.
log('isByokGated competitor-lens', mod.isByokGated(primarySlug) === true);
log('isByokGated ai-readiness-audit', mod.isByokGated(secondarySlug) === true);
log('isByokGated pitch-coach', mod.isByokGated(tertiarySlug) === true);
log('isByokGated jwt-decode NOT gated', mod.isByokGated('jwt-decode') === false);
log('isByokGated uuid NOT gated', mod.isByokGated('uuid') === false);

// 2. Five free runs allowed for an IP/slug, sixth blocks.
mod.__resetByokGateForTests();
const ip1 = '203.0.113.1';
for (let i = 0; i < 5; i++) {
  const d = mod.decideByok(ip1, primarySlug, false);
  if (d.block) {
    log(`run #${i + 1} of 5 is allowed (expected false, got block)`, false);
  }
  mod.recordFreeRun(ip1, primarySlug);
}
const sixth = mod.decideByok(ip1, primarySlug, false);
log('first 5 allowed, 6th blocks', sixth.block === true);
log('6th decision reports usage=5', sixth.usage === 5);
log('6th decision reports limit=5', sixth.limit === 5);

// 3. BYOK bypass: caller with a key always passes, even after exhausting.
const byokDecision = mod.decideByok(ip1, primarySlug, true);
log('BYOK path bypasses block after exhaustion', byokDecision.block === false);
log('BYOK path still reports usage=5 for UI', byokDecision.usage === 5);

// 4. Per-IP separation: different IP gets its own fresh budget.
mod.__resetByokGateForTests();
for (let i = 0; i < 5; i++) mod.recordFreeRun('10.0.0.1', primarySlug);
const differentIp = mod.decideByok('10.0.0.2', primarySlug, false);
log('different IP has fresh budget', differentIp.block === false && differentIp.usage === 0);

// 5. Per-slug separation: different slug on the same IP gets fresh budget.
mod.__resetByokGateForTests();
for (let i = 0; i < 5; i++) mod.recordFreeRun('10.0.0.1', primarySlug);
const otherSlug = mod.decideByok('10.0.0.1', secondarySlug, false);
log(
  'different slug on same IP has fresh budget',
  otherSlug.block === false && otherSlug.usage === 0,
);
const sameSlugBlocked = mod.decideByok('10.0.0.1', primarySlug, false);
log('original (ip, slug) still blocked', sameSlugBlocked.block === true);

// 6. Window pruning: runs older than 24h drop out of the budget.
mod.__resetByokGateForTests();
const now = Date.now();
const longAgo = now - 25 * 60 * 60 * 1000; // 25h ago
for (let i = 0; i < 5; i++) mod.recordFreeRun('172.16.0.1', primarySlug, longAgo);
const afterWindow = mod.decideByok('172.16.0.1', primarySlug, false, now);
log(
  'runs >24h ago are pruned from budget',
  afterWindow.block === false && afterWindow.usage === 0,
);

// 7. Mixed-age window: 4 old + 1 fresh + 1 more incoming should pass (old
// pruned, 1 counted). Then fill to 5 fresh and verify the 6th blocks.
mod.__resetByokGateForTests();
const ip7 = '172.16.0.2';
for (let i = 0; i < 3; i++) mod.recordFreeRun(ip7, primarySlug, now - 25 * 60 * 60 * 1000);
mod.recordFreeRun(ip7, primarySlug, now - 60 * 1000);
const mixed = mod.decideByok(ip7, primarySlug, false, now);
log('mixed-age: old runs pruned, only 1 counted', mixed.usage === 1 && mixed.block === false);
for (let i = 0; i < 4; i++) mod.recordFreeRun(ip7, primarySlug, now);
const mixedBlocked = mod.decideByok(ip7, primarySlug, false, now);
log('after filling window, 6th blocks', mixedBlocked.block === true);

// 8. peekUsage never records — idempotent reads.
mod.__resetByokGateForTests();
const ip8 = '10.1.2.3';
mod.recordFreeRun(ip8, primarySlug);
log('peekUsage reads 1', mod.peekUsage(ip8, primarySlug) === 1);
log('peekUsage is idempotent (still 1)', mod.peekUsage(ip8, primarySlug) === 1);
log('peekUsage is idempotent (still 1, call 3)', mod.peekUsage(ip8, primarySlug) === 1);

// 9. byokRequiredResponse envelope shape (what the UI parses).
const env = mod.byokRequiredResponse(primarySlug, 5, 5);
log('envelope.error=byok_required', env.error === 'byok_required');
log('envelope.slug present', env.slug === primarySlug);
log('envelope.usage present', env.usage === 5);
log('envelope.limit present', env.limit === 5);
log('envelope.get_key_url points at AI Studio', typeof env.get_key_url === 'string' && env.get_key_url.includes('aistudio.google.com'));
log('envelope.message present (human copy)', typeof env.message === 'string' && env.message.length > 10);

// 10. decideByok doesn't mutate: calling it twice without recordFreeRun
// must not drift the counter. (peekUsage is what everything reads.)
mod.__resetByokGateForTests();
const ip10 = '10.5.5.5';
mod.recordFreeRun(ip10, primarySlug);
mod.decideByok(ip10, primarySlug, false);
mod.decideByok(ip10, primarySlug, false);
mod.decideByok(ip10, primarySlug, true); // BYOK path must not record either
log(
  'decideByok is read-only (usage still 1 after 3 calls)',
  mod.peekUsage(ip10, primarySlug) === 1,
);

// 11. Race-condition safety: recordFreeRun on burst of 6 calls without
// interleaved decideByok still caps at 5 from the server's perspective
// (the 6th decideByok will report usage=6 and block). The real fix for
// the race is in run.ts where we recordFreeRun BEFORE dispatching, but
// this test pins the semantics.
mod.__resetByokGateForTests();
const ip11 = '10.6.6.6';
for (let i = 0; i < 6; i++) mod.recordFreeRun(ip11, primarySlug);
const after6 = mod.decideByok(ip11, primarySlug, false);
log('after 6 recorded, 7th blocks with usage=6', after6.block === true && after6.usage === 6);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
