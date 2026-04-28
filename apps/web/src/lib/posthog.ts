// PostHog analytics wire-up (launch-infra #4, 2026-04-20).
//
// Minimal funnel-tracker. Off by default — boots only when
// VITE_POSTHOG_KEY is set at build time. Until Federico sets the real key,
// this module is a no-op: init() returns early, track()/identify() silently
// discard calls. Never throws, never blocks the app if PostHog fails to
// load (failure-degradation is explicit via a try/catch in init()).
//
// Only the 8 events listed in TrackedEvent are tracked. No session replay,
// no PII beyond user_id, no hidden autocapture beyond the defaults PostHog
// ships. The event list lives in TS so TypeScript will reject typos at
// compile time.
//
// Distinct ID policy:
//   - Authenticated session (cloud mode, real Better Auth user): use user.id.
//   - Anonymous / OSS local user: use the server-issued `floom_device`
//     cookie (minted by apps/server/src/services/session.ts). Falls back
//     to PostHog's default anonymous id if the cookie is absent (e.g. the
//     very first pageview before the session hook resolves).
//
// Identity is rebound every time the session hook resolves via
// identifyFromSession(). Login flips from device_id to user_id, logout
// flips back.

import posthog, { type PostHog, type PostHogConfig } from 'posthog-js';
import type { SessionMePayload } from './types';
import { getConsent, type Consent } from './consent';

/**
 * The exhaustive list of tracked events. Extending this is a code change,
 * not a config change — keeps the funnel schema tight.
 *
 * Launch funnel (issue #311):
 *   - landing_viewed     : pageview on the creator hero
 *   - page_view          : route change on any SPA page (client-side nav)
 *   - publish_clicked    : "Publish your app" CTA tap
 *   - publish_succeeded  : app was successfully published (app created)
 *   - signup_completed   : Better Auth /sign-up/email returned 200
 *   - signin_completed   : Better Auth /sign-in/email returned 200
 *   - run_triggered      : user invoked an app
 *   - run_succeeded      : run finished 2xx (app deployed + ran OK)
 *   - run_failed         : run finished non-2xx
 *   - share_link_opened  : someone landed on a /r/:runId permalink
 *
 * Issue #599 additions (analytics wiring PR):
 *   - waitlist_join       : waitlist modal/page form submission succeeded
 *   - byok_modal_open     : BYOK (bring-your-own-key) modal opened
 *   - docker_copy_click   : user copied the self-host Docker snippet
 */
export type TrackedEvent =
  | 'landing_viewed'
  | 'page_view'
  | 'publish_clicked'
  | 'publish_succeeded'
  | 'signup_completed'
  | 'signin_completed'
  | 'run_triggered'
  | 'run_succeeded'
  | 'run_failed'
  | 'share_link_opened'
  | 'waitlist_join'
  | 'byok_modal_open'
  | 'docker_copy_click';

type Props = Record<string, string | number | boolean | null | undefined>;

type Env = {
  VITE_POSTHOG_KEY?: string;
  VITE_POSTHOG_HOST?: string;
  MODE?: string;
};

function readEnv(): Env {
  // Vite inlines `import.meta.env.*` at build time. The cast keeps the
  // helper typed without dragging the whole ImportMetaEnv surface in.
  return (import.meta as { env?: Env }).env ?? {};
}

let initialized = false;
let enabled = false;

/**
 * Pure predicate: true iff PostHog SHOULD be initialized given the user's
 * consent choice and whether a PostHog key is configured. Exported for tests
 * so the gating contract is unit-checkable without touching the SDK.
 *
 * PostHog is a third-party processor (events leave the EU to PostHog's
 * ingest). We only boot it when the user has picked "Accept all" —
 * "Essential only" keeps it fully dark.
 */
export function shouldInitPostHog(
  consent: Consent | null,
  key: string | undefined,
): boolean {
  return consent === 'all' && Boolean(key && key.length > 0);
}

/**
 * Read the `floom_device` cookie set by the server. Used as the anonymous
 * distinct_id so every pre-login event shares one identity.
 */
function readDeviceCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = /(?:^|;\s*)floom_device=([^;]+)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Boot PostHog. Safe to call multiple times — the second call is a no-op
 * UNTIL the user upgrades consent (see `closePostHog` for the downgrade
 * side). When VITE_POSTHOG_KEY is unset OR the user has not consented,
 * this is a hard no-op: track() and identifyFromSession() short-circuit.
 */
export function initPostHog(): void {
  if (initialized && enabled) return;
  const env = readEnv();
  const key = env.VITE_POSTHOG_KEY;
  if (!shouldInitPostHog(getConsent(), key)) {
    initialized = true;
    enabled = false;
    return;
  }
  initialized = true;
  try {
    const config: Partial<PostHogConfig> = {
      api_host: env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com',
      // Respect EU data residency by default. Override via VITE_POSTHOG_HOST
      // if Federico's project is on us.i.posthog.com.
      person_profiles: 'identified_only',
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      autocapture: false,
      // Don't log anything to console in production.
      loaded: (ph: PostHog) => {
        const anon = readDeviceCookie();
        if (anon) ph.register({ device_id: anon });
      },
    };
    posthog.init(key as string, config);
    enabled = true;
  } catch {
    // PostHog init failed. Swallow and stay disabled — never break the app.
    enabled = false;
  }
}

/**
 * Rebind identity from the current session payload. Call on every
 * useSession resolve so login/logout transitions are picked up.
 */
export function identifyFromSession(session: SessionMePayload | null): void {
  if (!enabled) return;
  try {
    if (session && !session.user.is_local) {
      // Real cloud user. Bind analytics identity to the Better Auth user id.
      posthog.identify(session.user.id, {
        cloud_mode: session.cloud_mode,
      });
    } else {
      // Anonymous / OSS local. Prefer the device cookie; fall back to
      // PostHog's own anonymous id (auto-generated on first load).
      const anon = readDeviceCookie();
      if (anon) {
        // Only re-identify if the current distinct_id isn't already the
        // device cookie value, otherwise we'd create redundant aliases.
        const current = posthog.get_distinct_id();
        if (current !== anon) posthog.identify(anon);
      }
    }
  } catch {
    // Identity bind failed. No-op.
  }
}

/**
 * Clear PostHog identity (call on logout).
 */
export function resetPostHog(): void {
  if (!enabled) return;
  try {
    posthog.reset();
  } catch {
    // no-op
  }
}

/**
 * Stop PostHog cleanly when the user downgrades consent from "all" to
 * "essential". Calls `reset()` to drop the current distinct_id and `opt_out_capturing()`
 * so no further events fire. Safe to call when PostHog was never
 * initialised.
 *
 * Note: same limitation as Sentry's close — anything already in flight at
 * the network layer can't be recalled. Documented on /cookies.
 */
export function closePostHog(): void {
  if (!enabled) {
    // If we were never enabled but initialised, reset flags so a later
    // upgrade can re-init cleanly.
    initialized = false;
    return;
  }
  try {
    posthog.opt_out_capturing();
    posthog.reset();
  } catch {
    // no-op
  }
  enabled = false;
  initialized = false;
}

/**
 * Emit a tracked event. Unknown event names are blocked by the TS type.
 * Properties are passed through verbatim; callers own schema evolution.
 */
export function track(event: TrackedEvent, props?: Props): void {
  if (!enabled) return;
  try {
    posthog.capture(event, props);
  } catch {
    // no-op
  }
}

/**
 * True once PostHog has been initialized AND a key was provided. Useful
 * in tests that want to assert "analytics is live" without reading env.
 */
export function isPostHogEnabled(): boolean {
  return enabled;
}
