import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { healthRouter } from './routes/health.js';
import { hubRouter } from './routes/hub.js';
import { parseRouter } from './routes/parse.js';
import { pickRouter } from './routes/pick.js';
import { threadRouter } from './routes/thread.js';
import { runRouter, slugRunRouter } from './routes/run.js';
import { jobsRouter } from './routes/jobs.js';
import { mcpRouter } from './routes/mcp.js';
import { deployWaitlistRouter } from './routes/deploy-waitlist.js';
import { seedFromFile } from './services/seed.js';
import { ingestOpenApiApps } from './services/openapi-ingest.js';
import { backfillAppEmbeddings } from './services/embeddings.js';
import { globalAuthMiddleware } from './lib/auth.js';
import { startJobWorker } from './services/worker.js';

const PORT = Number(process.env.PORT || 3051);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const app = new Hono();
app.use('*', logger());
app.use('*', cors({ origin: '*' }));
// Global auth gate: if FLOOM_AUTH_TOKEN is set, every API/MCP/p route
// requires a matching bearer token. /api/health is always open so health
// probes work. If the env var is unset, this is a no-op.
app.use('/api/*', globalAuthMiddleware);
app.use('/mcp/*', globalAuthMiddleware);
app.use('/p/*', globalAuthMiddleware);
if (process.env.FLOOM_AUTH_TOKEN) {
  console.log('[auth] FLOOM_AUTH_TOKEN is set — bearer auth required on all /api, /mcp, /p routes');
}

// API routes
app.route('/api/health', healthRouter);
app.route('/api/hub', hubRouter);
app.route('/api/parse', parseRouter);
app.route('/api/pick', pickRouter);
app.route('/api/thread', threadRouter);
app.route('/api/run', runRouter);
app.route('/mcp', mcpRouter);
// Slug-based run endpoint: POST /api/:slug/run
// Registered after /api/run to avoid prefix collision.
app.route('/api/:slug/run', slugRunRouter);
// Async job queue: POST/GET /api/:slug/jobs[/:job_id][/cancel]
app.route('/api/:slug/jobs', jobsRouter);
app.route('/api/deploy-waitlist', deployWaitlistRouter);

// Tiny, hand-written OpenAPI 3 document describing Floom's own admin API.
// Returned at /openapi.json so users hitting http://host/openapi.json get
// something useful instead of the SPA index.html.
app.get('/openapi.json', (c) =>
  c.json({
    openapi: '3.0.0',
    info: {
      title: 'Floom self-host API',
      version: '0.2.0',
      description:
        'Floom exposes three admin endpoints plus per-app run and MCP surfaces. For per-app tool schemas, call /api/hub and inspect each app manifest, or use the MCP tools/list over /mcp/app/:slug.',
    },
    paths: {
      '/api/health': {
        get: {
          summary: 'Server health',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/hub': {
        get: {
          summary: 'List all registered apps',
          responses: { '200': { description: 'JSON array of app records' } },
        },
      },
      '/api/{slug}/run': {
        post: {
          summary: 'Run an action on an app',
          parameters: [
            {
              name: 'slug',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    action: { type: 'string' },
                    inputs: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'run_id + status' } },
        },
      },
      '/mcp/app/{slug}': {
        post: {
          summary: 'Per-app MCP Streamable HTTP endpoint',
          description:
            'Accepts JSON-RPC 2.0 initialize / tools/list / tools/call. Requires both application/json AND text/event-stream in the Accept header.',
          parameters: [
            {
              name: 'slug',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'JSON-RPC 2.0 response' } },
        },
      },
    },
  }),
);

// Static web — serve the built Vite bundle from apps/web/dist when it exists.
// In dev, the web app is served on its own port by `vite` and this block is
// effectively a no-op (dist directory doesn't exist).
const here = dirname(fileURLToPath(import.meta.url));
// In dev (tsx src/index.ts): here = apps/server/src
// In prod (node dist/index.js): here = apps/server/dist
// In Docker (node /app/dist/index.js): here = /app/dist, web dist at /app/web/dist
const webDistCandidates = [
  process.env.WEB_DIST || '',
  resolve(here, '..', '..', 'web', 'dist'),        // apps/server/{src,dist} → apps/web/dist
  resolve(here, '..', '..', '..', 'web', 'dist'),  // /app/dist → /app/web/dist (docker)
  resolve(here, '..', 'web', 'dist'),              // flat layout
].filter(Boolean);

const webDist = webDistCandidates.find((p) => existsSync(p));
if (webDist) {
  console.log(`[web] serving static from ${webDist}`);
  // @hono/node-server's serveStatic only accepts paths relative to cwd, so we
  // do our own tiny static middleware using node:fs. Handles SPA fallback
  // (non-file paths under non-/api return index.html).
  const indexHtml = readFileSync(join(webDist, 'index.html'), 'utf-8');

  // Paths that must never be swallowed by the SPA wildcard. These reach
  // Hono's other route handlers or return a real 404. The order matters:
  // prefix matches first, then exact matches.
  const spaExcludedPrefixes = ['/api/', '/mcp'];
  const spaExcludedExact = new Set(['/openapi.json', '/metrics', '/docs']);

  app.use('/*', async (c, next) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // Skip API + MCP routes and named utility endpoints — let Hono handle them.
    if (
      spaExcludedPrefixes.some((p) => pathname.startsWith(p)) ||
      spaExcludedExact.has(pathname)
    ) {
      return next();
    }

    // Attempt to serve the file from disk.
    const candidate = join(webDist, pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''));
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        const ext = candidate.split('.').pop()?.toLowerCase() || '';
        const type =
          ext === 'html'
            ? 'text/html; charset=utf-8'
            : ext === 'js'
            ? 'application/javascript; charset=utf-8'
            : ext === 'css'
            ? 'text/css; charset=utf-8'
            : ext === 'json'
            ? 'application/json; charset=utf-8'
            : ext === 'svg'
            ? 'image/svg+xml'
            : ext === 'png'
            ? 'image/png'
            : ext === 'webp'
            ? 'image/webp'
            : 'application/octet-stream';
        const body = readFileSync(candidate);
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': type,
            'cache-control': ext === 'html' ? 'no-cache' : 'public, max-age=3600',
          },
        });
      }
    } catch {
      // fall through
    }

    // SPA fallback — return index.html for non-file routes.
    return c.html(indexHtml);
  });
} else {
  console.log('[web] no built web bundle found — backend-only mode');
  app.get('/', (c) =>
    c.json({
      service: 'floom-chat',
      message: 'Backend-only mode. Start the web dev server separately.',
      api: '/api/health',
    }),
  );
}


// Boot sequence: seed then start embeddings backfill in the background.
async function boot(): Promise<void> {
  try {
    seedFromFile();
  } catch (err) {
    console.error('[seed] failed:', err);
  }

  // OpenAPI ingest: if FLOOM_APPS_CONFIG is set, ingest apps from the config file.
  const appsConfigPath = process.env.FLOOM_APPS_CONFIG;
  if (appsConfigPath) {
    ingestOpenApiApps(appsConfigPath)
      .then((result) => {
        console.log(
          `[openapi-ingest] ${result.apps_ingested} apps ingested, ${result.apps_failed} failed`,
        );
      })
      .catch((err) => {
        console.error('[openapi-ingest] failed:', err);
      });
  }

  // Don't block boot on the network call.
  backfillAppEmbeddings().catch((err) => {
    console.error('[embeddings] backfill failed:', err);
  });

  // Start the background job worker for async apps (v0.3.0).
  // Opt-out via FLOOM_DISABLE_JOB_WORKER=true for tests that drive the
  // worker manually via `processOneJob`.
  if (process.env.FLOOM_DISABLE_JOB_WORKER !== 'true') {
    startJobWorker();
  }

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[server] listening on http://localhost:${info.port}`);
    console.log(`[server] public url: ${PUBLIC_URL}`);
  });
}

boot();
