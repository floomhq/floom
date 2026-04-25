// Prometheus-style /api/metrics endpoint. Secure by default: 404 when
// METRICS_TOKEN is unset; 401 on wrong token; 200 + text/plain otherwise.
// Results are cached for 15s so a busy scrape doesn't hammer SQLite.

import { Hono } from 'hono';
import { AUTH_DOCS_URL } from '../lib/auth.js';
import { storage } from '../services/storage.js';
import { snapshotMcpToolCalls, snapshotRateLimitHits } from '../lib/metrics-counters.js';

export const metricsRouter = new Hono();

const PROCESS_START_MS = Date.now();
const CACHE_TTL_MS = 15_000;

let cache: { body: string; expiresAt: number } | null = null;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function collectMetrics(): string {
  const lines: string[] = [];

  // floom_apps_total
  const apps = storage.countApps();
  lines.push('# HELP floom_apps_total Total number of registered apps in the Floom hub.');
  lines.push('# TYPE floom_apps_total gauge');
  lines.push(`floom_apps_total ${apps}`);

  // floom_runs_total{status=...}
  const statusRows = storage.getRunStatusCounts();
  const statusCounts = new Map<string, number>();
  for (const r of statusRows) statusCounts.set(r.status, r.count);
  lines.push('# HELP floom_runs_total Total runs grouped by status.');
  lines.push('# TYPE floom_runs_total counter');
  // Always emit the three documented statuses so Prometheus has stable series.
  for (const status of ['success', 'error', 'timeout']) {
    lines.push(`floom_runs_total{status="${status}"} ${statusCounts.get(status) || 0}`);
  }
  for (const [status, n] of statusCounts) {
    if (['success', 'error', 'timeout'].includes(status)) continue;
    lines.push(`floom_runs_total{status="${escapeLabel(status)}"} ${n}`);
  }

  // floom_active_users_last_24h — distinct user_id on runs in the last 24h.
  // `device_id` also counts; anonymous visitors have user_id='local' and a
  // unique device_id, so we union the two. COALESCE so NULL user_id rows
  // fall back to device_id.
  const activeUsers = storage.getActiveUsersLast24h();
  lines.push('# HELP floom_active_users_last_24h Distinct (user_id, device_id) pairs that ran an app in the past 24h.');
  lines.push('# TYPE floom_active_users_last_24h gauge');
  lines.push(`floom_active_users_last_24h ${activeUsers}`);

  // floom_mcp_tool_calls_total{tool_name="..."}
  lines.push('# HELP floom_mcp_tool_calls_total Total per-app MCP tool invocations since process start.');
  lines.push('# TYPE floom_mcp_tool_calls_total counter');
  const mcpEntries = Object.entries(snapshotMcpToolCalls());
  if (mcpEntries.length === 0) {
    lines.push(`floom_mcp_tool_calls_total{tool_name="_none"} 0`);
  } else {
    for (const [tool, n] of mcpEntries) {
      lines.push(`floom_mcp_tool_calls_total{tool_name="${escapeLabel(tool)}"} ${n}`);
    }
  }

  // floom_process_uptime_seconds
  const uptime = Math.floor((Date.now() - PROCESS_START_MS) / 1000);
  lines.push('# HELP floom_process_uptime_seconds Seconds since the Floom server process started.');
  lines.push('# TYPE floom_process_uptime_seconds gauge');
  lines.push(`floom_process_uptime_seconds ${uptime}`);

  // floom_rate_limit_hits_total{scope=...}
  lines.push('# HELP floom_rate_limit_hits_total Total 429 responses emitted by the rate limiter, grouped by scope.');
  lines.push('# TYPE floom_rate_limit_hits_total counter');
  const rlSnap = snapshotRateLimitHits();
  // Emit all four scopes so the series is always present.
  for (const scope of ['ip', 'user', 'app', 'mcp_ingest']) {
    const n = rlSnap[scope] || 0;
    lines.push(`floom_rate_limit_hits_total{scope="${scope}"} ${n}`);
  }

  return lines.join('\n') + '\n';
}

function isEnabled(): boolean {
  return Boolean(process.env.METRICS_TOKEN && process.env.METRICS_TOKEN.length > 0);
}

metricsRouter.get('/', (c) => {
  if (!isEnabled()) {
    // Secure-by-default: pretend the route doesn't exist.
    return c.notFound();
  }
  const expected = process.env.METRICS_TOKEN as string;
  const header = c.req.header('authorization') || c.req.header('Authorization') || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  const presented = match ? match[1] : '';
  if (!presented || !constantTimeEqual(presented, expected)) {
    // Structured JSON so agents + ops tooling can branch on `code` / `hint`
    // the same way they do for every other 401 on the server. Prometheus
    // scrapes treat any non-2xx as a failed scrape regardless of body
    // shape, so JSON here doesn't break the collector.
    return c.json(
      {
        error: 'Unauthorized',
        code: 'auth_required',
        hint: 'Present the metrics scrape token via Authorization: Bearer <token>. Contact your Floom administrator if you need the token rotated.',
        docs_url: AUTH_DOCS_URL,
      },
      401,
    );
  }

  const now = Date.now();
  if (!cache || cache.expiresAt <= now) {
    cache = { body: collectMetrics(), expiresAt: now + CACHE_TTL_MS };
  }
  return new Response(cache.body, {
    status: 200,
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
});

/** Test-only: drop the cached payload. */
export function __resetMetricsCacheForTests(): void {
  cache = null;
}
