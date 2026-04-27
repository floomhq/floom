import type { ObservabilityAdapter } from '@floom/adapter-types';
import { metrics, trace, SpanStatusCode, type Attributes } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface OtelObservabilityOptions {
  serviceName: string;
  otlpEndpoint?: string;
  batchTimeoutMs?: number;
}

type GaugePoint = {
  value: number;
  attributes: Attributes;
};

const DEFAULT_SERVICE_NAME = 'floom-server';
const SECRET_KEY_RE = /password|secret|api_key|token|authorization|bearer|cookie|set-cookie|sk-[a-z]+/i;
const SECRET_STRING_RE =
  /\b(password|secret|api_key|token|authorization|bearer|cookie|set-cookie)\b\s*[:=]\s*["']?[^"',\s}]+["']?|sk-[A-Za-z0-9_-]+/gi;

class OtelObservabilityAdapter implements ObservabilityAdapter {
  private readonly serviceName: string;
  private readonly endpoint: string | undefined;
  private readonly meter = metrics.getMeter('@floomhq/observability-otel');
  private readonly tracer = trace.getTracer('@floomhq/observability-otel');
  private readonly counters = new Map<string, ReturnType<typeof this.meter.createCounter>>();
  private readonly histograms = new Map<string, ReturnType<typeof this.meter.createHistogram>>();
  private readonly gauges = new Map<string, { points: Map<string, GaugePoint> }>();
  private sdk: NodeSDK | null = null;
  private sdkStart: Promise<void> | null = null;

  constructor(opts: OtelObservabilityOptions) {
    this.serviceName = opts.serviceName || DEFAULT_SERVICE_NAME;
    this.endpoint = normalizeEndpoint(
      opts.otlpEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    );
    if (this.endpoint) {
      this.startSdk(opts.batchTimeoutMs);
    }
  }

  captureError(err: unknown, context?: Record<string, unknown>): void {
    safe(() => {
      if (!this.endpoint) return;
      const normalized = normalizeError(err);
      const attributes = flattenAttributes('context', scrubValue(context ?? {}));
      const activeSpan = trace.getActiveSpan();
      const span = activeSpan ?? this.tracer.startSpan('floom.error');
      span.addEvent('exception', {
        'exception.type': normalized.type,
        'exception.message': scrubString(normalized.message),
        'exception.stacktrace': scrubString(normalized.stacktrace),
        ...attributes,
      });
      if (!activeSpan) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: scrubString(normalized.message),
        });
        span.end();
      }
    });
  }

  increment(
    metric: string,
    amount = 1,
    tags?: Record<string, string>,
  ): void {
    safe(() => {
      const name = metricName(metric);
      const value = finiteNumber(amount, 1);
      const attributes = tagAttributes(tags);
      if (!this.endpoint) {
        console.log(`[metric] counter ${name} +${value}${formatTags(tags)}`);
        return;
      }
      this.counter(name).add(value, attributes);
    });
  }

  timing(metric: string, ms: number, tags?: Record<string, string>): void {
    safe(() => {
      const name = metricName(metric);
      const value = finiteNumber(ms, 0);
      const attributes = tagAttributes(tags);
      if (!this.endpoint) {
        console.log(`[metric] timing  ${name} ${value}ms${formatTags(tags)}`);
        return;
      }
      this.histogram(name).record(value, attributes);
    });
  }

  gauge(metric: string, value: number, tags?: Record<string, string>): void {
    safe(() => {
      const name = metricName(metric);
      const normalizedValue = finiteNumber(value, 0);
      const attributes = tagAttributes(tags);
      if (!this.endpoint) {
        console.log(`[metric] gauge   ${name} =${normalizedValue}${formatTags(tags)}`);
        return;
      }
      this.gaugeStore(name).points.set(attributeKey(attributes), {
        value: normalizedValue,
        attributes,
      });
    });
  }

  async close(): Promise<void> {
    if (!this.sdk) return;
    await this.sdkStart;
    await this.sdk.shutdown();
  }

  private startSdk(batchTimeoutMs?: number): void {
    safe(() => {
      const traceExporter = new OTLPTraceExporter({
        url: `${this.endpoint}/v1/traces`,
      });
      const metricReader = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${this.endpoint}/v1/metrics`,
        }),
        exportIntervalMillis: finiteNumber(batchTimeoutMs, 60_000),
      });
      const sdk = new NodeSDK({
        resource: new Resource({
          [ATTR_SERVICE_NAME]: this.serviceName,
        }),
        traceExporter,
        metricReader,
      });
      this.sdk = sdk;
      this.sdkStart = Promise.resolve(sdk.start()).catch(() => undefined);
    });
  }

  private counter(metric: string): ReturnType<typeof this.meter.createCounter> {
    const existing = this.counters.get(metric);
    if (existing) return existing;
    const created = this.meter.createCounter(metric);
    this.counters.set(metric, created);
    return created;
  }

  private histogram(metric: string): ReturnType<typeof this.meter.createHistogram> {
    const existing = this.histograms.get(metric);
    if (existing) return existing;
    const created = this.meter.createHistogram(metric, { unit: 'ms' });
    this.histograms.set(metric, created);
    return created;
  }

  private gaugeStore(metric: string): { points: Map<string, GaugePoint> } {
    const existing = this.gauges.get(metric);
    if (existing) return existing;
    const store = { points: new Map<string, GaugePoint>() };
    const gauge = this.meter.createObservableGauge(metric);
    gauge.addCallback((observableResult) => {
      for (const point of store.points.values()) {
        observableResult.observe(point.value, point.attributes);
      }
    });
    this.gauges.set(metric, store);
    return store;
  }
}

export function createOtelObservabilityAdapter(
  opts: OtelObservabilityOptions,
): ObservabilityAdapter {
  return new OtelObservabilityAdapter(opts);
}

export const otelObservabilityAdapter: ObservabilityAdapter =
  createOtelObservabilityAdapter({
    serviceName: process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME,
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

export default {
  kind: 'observability' as const,
  name: 'otel',
  protocolVersion: '^0.2',
  create: createOtelObservabilityAdapter,
  adapter: otelObservabilityAdapter,
};

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* observability must never break requests */
  }
}

function normalizeEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

function metricName(metric: string): string {
  return typeof metric === 'string' && metric.trim().length > 0
    ? metric.trim()
    : 'floom.metric';
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function tagAttributes(tags?: Record<string, string>): Attributes {
  if (!tags) return {};
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(tags)) {
    if (typeof key === 'string' && key.length > 0 && typeof value === 'string') {
      attributes[key] = value;
    }
  }
  return attributes;
}

function formatTags(tags?: Record<string, string>): string {
  const attributes = tagAttributes(tags);
  const parts = Object.entries(attributes).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}

function attributeKey(attributes: Attributes): string {
  return JSON.stringify(
    Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeError(err: unknown): {
  type: string;
  message: string;
  stacktrace: string;
} {
  if (err instanceof Error) {
    return {
      type: err.name || 'Error',
      message: err.message || '',
      stacktrace: err.stack || '',
    };
  }
  return {
    type: typeof err,
    message: typeof err === 'string' ? err : safeStringify(err),
    stacktrace: '',
  };
}

function scrubValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: scrubString(value.stack || ''),
    };
  }
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, seen));
  const scrubbed: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    scrubbed[key] = SECRET_KEY_RE.test(key)
      ? '<redacted>'
      : scrubValue(nestedValue, seen);
  }
  return scrubbed;
}

function scrubString(value: string): string {
  return value.replace(SECRET_STRING_RE, '<redacted>');
}

function flattenAttributes(prefix: string, value: unknown): Attributes {
  const out: Attributes = {};
  flattenInto(out, prefix, value);
  return out;
}

function flattenInto(out: Attributes, key: string, value: unknown): void {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return;
  }
  if (value === null) {
    out[key] = 'null';
    return;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    out[key] = typeof value === 'string' ? scrubString(value) : value;
    return;
  }
  if (Array.isArray(value)) {
    out[key] = safeStringify(value);
    return;
  }
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    flattenInto(out, `${key}.${nestedKey}`, nestedValue);
  }
}

function safeStringify(value: unknown): string {
  try {
    return scrubString(JSON.stringify(value));
  } catch {
    return '[Unserializable]';
  }
}
