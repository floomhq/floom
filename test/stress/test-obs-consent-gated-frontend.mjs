#!/usr/bin/env node
// Contract tests for frontend telemetry (#311).
//
// Two third-party processors boot from the web bundle — Sentry (errors)
// and PostHog (product analytics). Sentry is controlled by
// VITE_SENTRY_WEB_DSN so launch-day errors are captured before React
// mounts. PostHog remains consent-gated.
//
// The web app uses Vite + import.meta.env, so we can't import the modules
// directly in Node. We verify the contract in two layers:
//
//   1. Pure predicate matrix — `shouldInitBrowserSentry` and
//      `shouldInitPostHog` live in the source as pure functions.
//   2. Source-string invariants — assert the production modules export
//      those predicates with the exact (consent === 'all' && key-present)
//      shape so this test's inline copies can't drift from production.
//
// Run: node test/stress/test-obs-consent-gated-frontend.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

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

// ---------------------------------------------------------------------------
// 1. Pure predicate matrix — Sentry.
// ---------------------------------------------------------------------------
function shouldInitSentry(dsn) {
  return Boolean(dsn);
}

log('Sentry: no dsn      -> false', shouldInitSentry(undefined) === false);
log('Sentry: empty dsn   -> false', shouldInitSentry('') === false);
log('Sentry: dsn         -> true', shouldInitSentry('https://x') === true);

// ---------------------------------------------------------------------------
// 2. Pure predicate matrix — PostHog.
// ---------------------------------------------------------------------------
function shouldInitPostHog(consent, key) {
  return consent === 'all' && Boolean(key && key.length > 0);
}

log('PostHog: essential + key  -> false', shouldInitPostHog('essential', 'phc_x') === false);
log('PostHog: null + key        -> false', shouldInitPostHog(null, 'phc_x') === false);
log('PostHog: all + no key      -> false', shouldInitPostHog('all', undefined) === false);
log('PostHog: all + empty key   -> false', shouldInitPostHog('all', '') === false);
log('PostHog: all + key         -> true', shouldInitPostHog('all', 'phc_x') === true);

// ---------------------------------------------------------------------------
// 3. Source-string invariants — guard against drift.
// ---------------------------------------------------------------------------
const sentrySrc = readFileSync(
  join(REPO_ROOT, 'apps/web/src/lib/sentry.ts'),
  'utf8',
);
const posthogSrc = readFileSync(
  join(REPO_ROOT, 'apps/web/src/lib/posthog.ts'),
  'utf8',
);
const consentSrc = readFileSync(
  join(REPO_ROOT, 'apps/web/src/lib/consent.ts'),
  'utf8',
);
const cookieBannerSrc = readFileSync(
  join(REPO_ROOT, 'apps/web/src/components/CookieBanner.tsx'),
  'utf8',
);
const mainSrc = readFileSync(
  join(REPO_ROOT, 'apps/web/src/main.tsx'),
  'utf8',
);

// Invariant: Sentry gating predicate is `Boolean(dsn)`.
log(
  'Sentry source contains `Boolean(dsn)` predicate',
  /return\s+Boolean\(dsn\)/.test(sentrySrc),
);
log(
  'Sentry source exports `shouldInitBrowserSentry`',
  /export function shouldInitBrowserSentry/.test(sentrySrc),
);
log(
  'Sentry source reads `VITE_SENTRY_WEB_DSN`',
  /VITE_SENTRY_WEB_DSN/.test(sentrySrc),
);
log(
  'Sentry source samples browser traces at 5%',
  /tracesSampleRate:\s*0\.05/.test(sentrySrc),
);

// Invariant: PostHog gating predicate is `consent === 'all' && Boolean(key ...)`.
log(
  "PostHog source contains `consent === 'all'` predicate",
  /consent\s*===\s*'all'\s*&&\s*Boolean\(key/.test(posthogSrc),
);
log(
  'PostHog source exports `shouldInitPostHog`',
  /export function shouldInitPostHog/.test(posthogSrc),
);
log(
  'PostHog source calls `shouldInitPostHog` from init path',
  /shouldInitPostHog\(getConsent\(\)/.test(posthogSrc),
);
log(
  'PostHog source exposes `closePostHog` for downgrade flow',
  /export function closePostHog/.test(posthogSrc),
);

// Invariant: consent module persists to BOTH localStorage and document.cookie.
log(
  'consent source writes to localStorage under `floom.cookie-consent`',
  consentSrc.includes("'floom.cookie-consent'") &&
    consentSrc.includes('localStorage.setItem'),
);
log(
  'consent source mirrors to document.cookie with Max-Age + SameSite=Lax',
  /document\.cookie\s*=/.test(consentSrc) &&
    /SameSite=Lax/.test(consentSrc) &&
    /Max-Age=/.test(consentSrc),
);
log(
  'consent source emits `floom:cookie-consent-change` event for subscribers',
  /floom:cookie-consent-change/.test(consentSrc),
);

// Invariant: CookieBanner uses the consent module and controls PostHog
// in-session (no page reload required).
log(
  'CookieBanner imports `setConsent` from consent module',
  /setConsent/.test(cookieBannerSrc) && /from ['\"]\.\.\/lib\/consent/.test(cookieBannerSrc),
);
log(
  'CookieBanner initialises PostHog on "Accept all"',
  /initPostHog\(\)/.test(cookieBannerSrc),
);
log(
  'CookieBanner flushes PostHog on downgrade',
  /closePostHog\(\)/.test(cookieBannerSrc),
);

// Invariant: main.tsx boot calls init fns, NOT inline Sentry.init.
log(
  'main.tsx boot calls `initBrowserSentry()`',
  /initBrowserSentry\(\)/.test(mainSrc),
);
log(
  'main.tsx boot calls `initPostHog()`',
  /initPostHog\(\)/.test(mainSrc),
);
log(
  'main.tsx does NOT call `Sentry.init(` directly',
  !/Sentry\.init\(/.test(mainSrc),
);

// Invariant: the full TrackedEvent union now includes signin_completed
// (launch #311 added it to distinguish login from signup).
log(
  "PostHog TrackedEvent union includes 'signin_completed'",
  /'signin_completed'/.test(posthogSrc),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
