// Optional Sentry wiring for the Floom server.
//
// The integration is a no-op when `SENTRY_SERVER_DSN` is unset. `index.ts`
// imports the tiny sentry-init side-effect module before route imports so
// process handlers and SDK patching are installed as early as ESM allows.
// `captureServerError(err, context?)` is safe to call whether Sentry is
// enabled or not.

import * as Sentry from '@sentry/node';

const SECRET_KEY_PATTERN = /(password|token|api[_-]?key|authorization|secret|cookie)/i;
const SENSITIVE_HEADER_NAMES = new Set(['authorization', 'cookie', 'x-api-key']);
const SENSITIVE_URL_PARAM_PATTERN = /(token|api[_-]?key|key|secret|password|authorization|cookie)/i;
const SERVICE_NAME = 'floom-server';

type MutableRecord = Record<string, unknown>;

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

function scrubSensitiveUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAM_PATTERN.test(key)) {
        url.searchParams.set(key, '[Scrubbed]');
      }
    }
    return url.toString();
  } catch {
    return rawUrl.replace(
      /([?&][^=]*(?:token|api[_-]?key|key|secret|password|authorization|cookie)[^=]*=)[^&]*/gi,
      '$1[Scrubbed]',
    );
  }
}

function scrubHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== 'object') return headers;
  const record = headers as MutableRecord;
  for (const key of Object.keys(record)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
      delete record[key];
    }
  }
  return record;
}

function scrubRequest(request: unknown): unknown {
  if (!request || typeof request !== 'object') return request;
  const record = request as MutableRecord;
  delete record.data;
  delete record.body;
  delete record.cookies;
  if (typeof record.url === 'string') {
    record.url = scrubSensitiveUrl(record.url);
  }
  if ('headers' in record) {
    scrubHeaders(record.headers);
  }
  return scrubSecrets(record);
}

function scrubBreadcrumbs(breadcrumbs: unknown): unknown {
  if (!Array.isArray(breadcrumbs)) return breadcrumbs;
  for (const breadcrumb of breadcrumbs) {
    if (!breadcrumb || typeof breadcrumb !== 'object') continue;
    const record = breadcrumb as MutableRecord;
    if (typeof record.message === 'string') {
      record.message = scrubSensitiveUrl(record.message);
    }
    if ('data' in record) {
      scrubSecrets(record.data);
    }
  }
  return breadcrumbs;
}

export function scrubSentryEvent<T extends { request?: unknown; extra?: unknown; contexts?: unknown; breadcrumbs?: unknown }>(
  event: T,
): T {
  if (event.request) scrubRequest(event.request);
  if (event.extra) scrubSecrets(event.extra);
  if (event.contexts) scrubSecrets(event.contexts);
  if (event.breadcrumbs) scrubBreadcrumbs(event.breadcrumbs);
  return event;
}

let initialized = false;
let startupLogged = false;

function readEnvironment(): string {
  const publicUrl = process.env.PUBLIC_URL || '';
  const inferredFromUrl = publicUrl.includes('preview.')
    ? 'preview'
    : publicUrl.includes('floom.dev')
      ? 'prod'
      : undefined;
  return (
    process.env.SENTRY_ENVIRONMENT ||
    process.env.FLOOM_ENV ||
    inferredFromUrl ||
    process.env.NODE_ENV ||
    'development'
  );
}

function readCommitSha(): string {
  return process.env.COMMIT_SHA || process.env.SENTRY_RELEASE || 'unknown';
}

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_SERVER_DSN;
  if (!dsn) {
    if (!startupLogged) {
      console.log('[sentry] DSN not set, error tracking disabled');
      startupLogged = true;
    }
    return;
  }
  const environment = readEnvironment();
  const commit = readCommitSha();
  const release = process.env.SENTRY_RELEASE || (commit !== 'unknown' ? `floom-server@${commit}` : undefined);
  Sentry.init({
    dsn,
    environment,
    ...(release ? { release } : {}),
    tracesSampleRate: 0.1,
    initialScope(scope) {
      scope.setTag('service', SERVICE_NAME);
      scope.setTag('env', environment);
      scope.setTag('commit', commit);
      return scope;
    },
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
  });
  initialized = true;
  console.log(
    `[sentry] ready service=${SERVICE_NAME} env=${environment} commit=${commit}`,
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
export const __testing = {
  scrubSecrets,
  scrubSensitiveUrl,
  scrubHeaders,
  scrubRequest,
  scrubSentryEvent,
  resetForTests() {
    initialized = false;
    startupLogged = false;
  },
};
