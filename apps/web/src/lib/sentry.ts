// Optional browser Sentry init.
//
// Error tracking is controlled only by `VITE_SENTRY_WEB_DSN`. Empty DSN keeps
// the SDK fully dark and logs one startup line. A configured DSN initializes
// before React mounts so client exceptions, unhandled promise rejections, and
// the React error boundary all land in Sentry.

import * as Sentry from '@sentry/react';

const SECRET_RE = /(password|token|api[_-]?key|authorization|secret|cookie)/i;
const SENSITIVE_URL_PARAM_RE = /(token|api[_-]?key|key|secret|password|authorization|cookie)/i;
const USER_INPUT_BREADCRUMB_KEY_RE = /^(input|value|text|message|target|label|title|innerText|outerHTML)$/i;
const SERVICE_NAME = 'floom-web';

type MutableRecord = Record<string, unknown>;

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

function scrubSensitiveUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, typeof window !== 'undefined' ? window.location.origin : 'https://floom.dev');
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAM_RE.test(key)) {
        url.searchParams.set(key, '[Scrubbed]');
      }
    }
    if (/^https?:\/\//i.test(rawUrl)) return url.toString();
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return rawUrl.replace(
      /([?&][^=]*(?:token|api[_-]?key|key|secret|password|authorization|cookie)[^=]*=)[^&]*/gi,
      '$1[Scrubbed]',
    );
  }
}

function scrubRequest(request: unknown): unknown {
  if (!request || typeof request !== 'object') return request;
  const record = request as MutableRecord;
  delete record.data;
  delete record.body;
  if (typeof record.url === 'string') {
    record.url = scrubSensitiveUrl(record.url);
  }
  if (typeof record.query_string === 'string') {
    record.query_string = scrubSensitiveUrl(`/?${record.query_string}`).slice(2);
  }
  return scrubDeep(record);
}

function scrubBreadcrumbs(breadcrumbs: unknown): unknown {
  if (!Array.isArray(breadcrumbs)) return breadcrumbs;
  for (const breadcrumb of breadcrumbs) {
    if (!breadcrumb || typeof breadcrumb !== 'object') continue;
    const record = breadcrumb as MutableRecord;
    if (typeof record.message === 'string') {
      record.message = scrubSensitiveUrl(record.message);
    }
    if (typeof record.category === 'string' && record.category.startsWith('ui.')) {
      record.message = '[Scrubbed]';
    }
    if (record.data && typeof record.data === 'object') {
      const data = record.data as MutableRecord;
      for (const key of Object.keys(data)) {
        if (USER_INPUT_BREADCRUMB_KEY_RE.test(key)) {
          delete data[key];
        } else if (typeof data[key] === 'string') {
          data[key] = scrubSensitiveUrl(data[key]);
        }
      }
      scrubDeep(data);
    }
  }
  return breadcrumbs;
}

export function scrubBrowserSentryEvent<
  T extends { request?: unknown; extra?: unknown; contexts?: unknown; breadcrumbs?: unknown },
>(event: T): T {
  if (event.request) scrubRequest(event.request);
  if (event.extra) scrubDeep(event.extra);
  if (event.contexts) scrubDeep(event.contexts);
  if (event.breadcrumbs) scrubBreadcrumbs(event.breadcrumbs);
  return event;
}

function readEnv(): Record<string, string | undefined> {
  return (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
}

function readDsn(): string | undefined {
  return readEnv().VITE_SENTRY_WEB_DSN;
}

function readEnvironment(): string {
  const env = readEnv();
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
  const inferredFromHost = hostname.startsWith('preview.')
    ? 'preview'
    : hostname === 'floom.dev' || hostname === 'www.floom.dev'
      ? 'prod'
      : undefined;
  return env.VITE_SENTRY_ENVIRONMENT || inferredFromHost || env.MODE || 'production';
}

function readCommitSha(): string {
  const env = readEnv();
  return env.VITE_COMMIT_SHA || env.VITE_SENTRY_RELEASE || 'unknown';
}

export function shouldInitBrowserSentry(dsn: string | undefined): boolean {
  return Boolean(dsn);
}

let initialized = false;
let startupLogged = false;

/**
 * Initialize browser Sentry iff a DSN is set. Idempotent — second call is a
 * no-op. Returns true if the SDK is now (or was already) live, false otherwise.
 */
export function initBrowserSentry(): boolean {
  if (initialized) return true;
  const dsn = readDsn();
  if (!shouldInitBrowserSentry(dsn)) {
    if (!startupLogged) {
      console.log('[sentry] disabled');
      startupLogged = true;
    }
    return false;
  }
  const environment = readEnvironment();
  const commit = readCommitSha();
  const release = readEnv().VITE_SENTRY_RELEASE || (commit !== 'unknown' ? `floom-web@${commit}` : undefined);
  Sentry.init({
    dsn,
    environment,
    ...(release ? { release } : {}),
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.05,
    initialScope(scope) {
      scope.setTag('service', SERVICE_NAME);
      scope.setTag('env', environment);
      scope.setTag('commit', commit);
      return scope;
    },
    beforeSend(event) {
      return scrubBrowserSentryEvent(event);
    },
  });
  initialized = true;
  console.log(`[sentry] ready service=${SERVICE_NAME} env=${environment} commit=${commit}`);
  return true;
}

/** Test-only: reset internal state. Not exported via any index. */
export function _resetBrowserSentryForTests(): void {
  initialized = false;
  startupLogged = false;
}

export const BrowserSentryErrorBoundary = Sentry.ErrorBoundary;

export const __testing = {
  scrubSensitiveUrl,
  scrubRequest,
  scrubBreadcrumbs,
  scrubBrowserSentryEvent,
};
