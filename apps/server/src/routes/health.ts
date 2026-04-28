import { Hono } from 'hono';
import { SERVER_VERSION } from '../lib/server-version.js';
import { db } from '../db.js';
import { noteHealthStatus } from '../lib/alerts.js';
import { isDeployEnabled } from '../services/workspaces.js';

export const healthRouter = new Hono();

// GH #852 — /healthz: machine-readable health probe. Exposed via
// app.route('/api/healthz', healthzRouter) in index.ts (separate mount so
// the path resolves to /api/healthz, not /api/health/z).
export const healthzRouter = new Hono();
healthzRouter.get('/', (c) => {
  return c.json({
    ok: true,
    deploy_enabled: isDeployEnabled(),
    uptime_seconds: Math.floor(process.uptime()),
    version: process.env.FLOOM_VERSION || SERVER_VERSION || 'dev',
  });
});

healthRouter.get('/', (c) => {
  try {
    const appCount = (db.prepare('SELECT COUNT(*) as c FROM apps').get() as {
      c: number;
    }).c;
    const threadCount = (db.prepare('SELECT COUNT(*) as c FROM run_threads').get() as {
      c: number;
    }).c;
    noteHealthStatus(200, 'ok');
    return c.json({
      status: 'ok',
      service: 'floom-chat',
      version: SERVER_VERSION,
      apps: appCount,
      threads: threadCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    noteHealthStatus(500, message);
    console.error('[health] failed:', err);
    return c.json(
      {
        status: 'error',
        error: 'internal_server_error',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});
