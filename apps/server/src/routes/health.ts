import { Hono } from 'hono';
import { SERVER_VERSION } from '../lib/server-version.js';
import { db } from '../db.js';
import { adapters } from '../adapters/index.js';

export const healthRouter = new Hono();

healthRouter.get('/', (c) => {
  const appCount = (db.prepare('SELECT COUNT(*) as c FROM apps').get() as { c: number }).c;
  const threadCount = (db.prepare('SELECT COUNT(*) as c FROM run_threads').get() as { c: number }).c;
  // Proof-of-pattern for the adapter factory (protocol-v0.2). The `adapters`
  // bundle comes from `createAdapters()` in adapters/index.ts; every
  // increment call is routed through the configured ObservabilityAdapter so
  // an alternate impl (OpenTelemetry, Datadog, StatsD) can swap in by env
  // var without a code change in this route. Zero behavior change: the
  // default impl is `console`, which writes one log line. See
  // docs/adapters.md.
  adapters.observability.increment('health.check');
  return c.json({
    status: 'ok',
    service: 'floom-chat',
    version: SERVER_VERSION,
    apps: appCount,
    threads: threadCount,
    timestamp: new Date().toISOString(),
  });
});
