// Optional Sentry wiring for the Floom server.
//
// The integration is a no-op when `SENTRY_DSN` is unset — the preview image
// ships without a DSN so Sentry stays off until a self-hoster or Floom Cloud
// wires it in via env. When the DSN is present we initialize once at boot,
// then `captureException` is safe to call from any route.
//
// Design:
//   - Hard-import `@sentry/node` is cheap (a few MB at boot) and gives us
//     predictable behavior; we only call `init()` conditionally.
//   - `beforeSend` scrubs common secret-ish keys before anything leaves the
//     process so we never leak tokens / passwords / API keys into Sentry.
//   - The public surface is two functions: `initSentry()` called once from
//     `index.ts`, and `captureServerError(err, context?)` used by error
//     handlers. Both are safe to call whether Sentry is enabled or not.

import * as Sentry from '@sentry/node';
import { SERVER_VERSION } from './server-version.js';

const SECRET_KEY_PATTERN = /(password|token|api[_-]?key|authorization|secret|cookie)/i;

/**
 * Recursively redact any object key that matches the secret pattern. Returns
 * the input mutated in place — Sentry's `beforeSend` hands us the event
 * object and expects either the same object back or null to drop it.
 */
function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return value; // guard pathological cycles
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubSecrets(value[i], depth + 1);
    return value;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        obj[key] = '[Scrubbed]';
      } else {
        obj[key] = scrubSecrets(obj[key], depth + 1);
      }
    }
    return obj;
  }
  return value;
}

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // no-op when unconfigured
  // `SENTRY_ENVIRONMENT` lets operators override when NODE_ENV doesn't
  // match the Sentry-side environment label (e.g. 'preview' vs 'production'
  // both running NODE_ENV=production).
  const environment =
    process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';
  // Tag the release so Sentry can group issues by deploy. `SENTRY_RELEASE`
  // wins if set (CI can inject a git sha); otherwise we fall back to the
  // server's package.json version so every event has some release tag.
  const release = process.env.SENTRY_RELEASE || `floom-server@${SERVER_VERSION}`;
  Sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      // Scrub request + extra payloads. Sentry's default scrubbing handles
      // top-level secret fields but we want to catch nested ones too.
      if (event.request) scrubSecrets(event.request);
      if (event.extra) scrubSecrets(event.extra);
      if (event.contexts) scrubSecrets(event.contexts);
      return event;
    },
  });
  initialized = true;
  console.log(
    `[sentry] initialized (environment=${environment}, release=${release})`,
  );
}

export function sentryEnabled(): boolean {
  return initialized;
}

/**
 * Capture a server-side exception. Safe to call whether or not Sentry was
 * initialized — the underlying SDK no-ops when `init` was never called.
 */
export function captureServerError(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    // Never let Sentry break the request.
  }
}

// Exposed for tests.
export const __testing = { scrubSecrets };
