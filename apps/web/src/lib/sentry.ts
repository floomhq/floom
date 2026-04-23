// Strict-opt-in browser Sentry init.
//
// Browser Sentry is a third-party processor under GDPR — events leave the
// EU and hit Sentry's ingest. We only init when the user has explicitly
// chosen "Accept all" in the cookie banner (Art. 6(1)(a) consent).
// "Essential only" keeps the SDK fully dark: no DSN call, no transport
// spin-up, no PII leak on first paint.
//
// Public API:
//   - shouldInitBrowserSentry(consent, dsn): pure predicate (unit-testable)
//   - initBrowserSentry():   idempotent; returns true iff init happened
//   - closeBrowserSentry():  best-effort flush + close when user downgrades
//
// CookieBanner calls init/close inline when the user chooses, so the
// change applies in the same session without a page reload.

import * as Sentry from '@sentry/react';
import { getConsent, type Consent } from './consent';

const SECRET_RE = /(password|token|api[_-]?key|authorization|secret|cookie)/i;

function scrubDeep(v: unknown, depth = 0): unknown {
  if (depth > 8 || v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (SECRET_RE.test(k)) obj[k] = '[Scrubbed]';
      else obj[k] = scrubDeep(obj[k], depth + 1);
    }
    return obj;
  }
  return v;
}

function readEnv(): Record<string, string | undefined> {
  return (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
}

function readDsn(): string | undefined {
  return readEnv().VITE_SENTRY_DSN;
}

function readEnvironment(): string {
  const env = readEnv();
  return env.VITE_SENTRY_ENVIRONMENT || env.MODE || 'production';
}

function readRelease(): string | undefined {
  return readEnv().VITE_SENTRY_RELEASE;
}

/**
 * Pure predicate: true iff browser Sentry SHOULD be initialized given the
 * user's consent choice and whether a DSN is configured. Exported for
 * tests so the gating contract is unit-checkable without touching the SDK.
 */
export function shouldInitBrowserSentry(
  consent: Consent | null,
  dsn: string | undefined,
): boolean {
  return consent === 'all' && Boolean(dsn);
}

let initialized = false;

/**
 * Initialize browser Sentry IFF the user accepted all cookies AND a DSN is
 * set. Idempotent — second call is a no-op. Returns true if the SDK is now
 * (or was already) live, false otherwise.
 */
export function initBrowserSentry(): boolean {
  if (initialized) return true;
  const dsn = readDsn();
  if (!shouldInitBrowserSentry(getConsent(), dsn)) return false;
  const release = readRelease();
  Sentry.init({
    dsn,
    environment: readEnvironment(),
    ...(release ? { release } : {}),
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request) scrubDeep(event.request);
      if (event.extra) scrubDeep(event.extra);
      if (event.contexts) scrubDeep(event.contexts);
      return event;
    },
  });
  initialized = true;
  return true;
}

/**
 * Best-effort close: flushes the queue and stops the SDK. Used when the
 * user downgrades from "Accept all" to "Essential only" mid-session. Note:
 * Sentry may have already enqueued an outbound request; `close()` waits up
 * to 2s for it to drain. Anything already in flight at the network layer
 * cannot be recalled — documented on /cookies.
 */
export function closeBrowserSentry(): void {
  if (!initialized) return;
  try {
    void Sentry.close(2000);
  } catch {
    // ignore
  }
  initialized = false;
}

/** Test-only: reset internal state. Not exported via any index. */
export function _resetBrowserSentryForTests(): void {
  initialized = false;
}
