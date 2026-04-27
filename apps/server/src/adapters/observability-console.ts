// Console + Sentry observability adapter wrapper.
//
// Wraps the existing Sentry error-capture path (`lib/sentry.ts`) and
// routes counter / timing / gauge metrics to stdout so they are visible
// in `docker logs` for a self-hosted operator. An alternate adapter
// would forward to OpenTelemetry, Datadog, StatsD, etc.
//
// The reference server's Prometheus-format endpoint at /api/metrics still
// reads from `lib/metrics-counters.ts` directly; this adapter layer is
// additive, not a replacement. Once the call sites migrate to
// `adapters.observability.increment(...)`, the counters module can be
// deleted in favor of the adapter's internal counters.
//
// Name (`console`) reflects the default no-dependency behavior: errors
// go to Sentry if configured, metrics go to stdout. In tests this is
// exactly what you want — no external emitter to mock.

import type { ObservabilityAdapter } from './types.js';
import { captureServerError } from '../lib/sentry.js';

function safe(fn: () => void): void {
  // Per the adapter contract: never throw. A broken observability path
  // must not break the request.
  try {
    fn();
  } catch {
    /* swallow */
  }
}

function formatTags(tags?: Record<string, string>): string {
  if (!tags) return '';
  const parts = Object.entries(tags).map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}

export const consoleObservabilityAdapter: ObservabilityAdapter = {
  captureError(err: unknown, context?: Record<string, unknown>): void {
    safe(() => captureServerError(err, context));
  },

  increment(metric: string, amount = 1, tags?: Record<string, string>): void {
    safe(() => {
      console.log(`[metric] counter ${metric} +${amount}${formatTags(tags)}`);
    });
  },

  timing(metric: string, ms: number, tags?: Record<string, string>): void {
    safe(() => {
      console.log(`[metric] timing  ${metric} ${ms}ms${formatTags(tags)}`);
    });
  },

  gauge(metric: string, value: number, tags?: Record<string, string>): void {
    safe(() => {
      console.log(`[metric] gauge   ${metric} =${value}${formatTags(tags)}`);
    });
  },
};
