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
import { runRouter } from './routes/run.js';
import { mcpRouter } from './routes/mcp.js';
import { seedFromFile } from './services/seed.js';
import { backfillAppEmbeddings } from './services/embeddings.js';

const PORT = Number(process.env.PORT || 3051);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const app = new Hono();
app.use('*', logger());
app.use('*', cors({ origin: '*' }));

// API routes
app.route('/api/health', healthRouter);
app.route('/api/hub', hubRouter);
app.route('/api/parse', parseRouter);
app.route('/api/pick', pickRouter);
app.route('/api/thread', threadRouter);
app.route('/api/run', runRouter);
app.route('/mcp', mcpRouter);

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

  app.use('/*', async (c, next) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // Skip API + MCP routes — let Hono handle them.
    if (pathname.startsWith('/api/') || pathname.startsWith('/mcp')) {
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
  // Don't block boot on the network call.
  backfillAppEmbeddings().catch((err) => {
    console.error('[embeddings] backfill failed:', err);
  });

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[server] listening on http://localhost:${info.port}`);
    console.log(`[server] public url: ${PUBLIC_URL}`);
  });
}

boot();
