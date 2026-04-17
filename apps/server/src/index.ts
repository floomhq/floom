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
import { runRouter, slugRunRouter, meRouter } from './routes/run.js';
import { jobsRouter } from './routes/jobs.js';
import { mcpRouter } from './routes/mcp.js';
import { rendererRouter } from './routes/renderer.js';
import { deployWaitlistRouter } from './routes/deploy-waitlist.js';
import { memoryRouter, secretsRouter } from './routes/memory.js';
import { connectionsRouter } from './routes/connections.js';
import { workspacesRouter, sessionRouter } from './routes/workspaces.js';
import { stripeRouter } from './routes/stripe.js';
import { reviewsRouter } from './routes/reviews.js';
import { feedbackRouter } from './routes/feedback.js';
import { seedFromFile } from './services/seed.js';
import { ingestOpenApiApps } from './services/openapi-ingest.js';
import { startFastApps } from './services/fast-apps-sidecar.js';
import { backfillAppEmbeddings } from './services/embeddings.js';
import { globalAuthMiddleware } from './lib/auth.js';
import { getAuth, isCloudMode, runAuthMigrations } from './lib/better-auth.js';
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
// Custom renderer bundles (W2.2): GET /renderer/:slug/bundle.js + /meta
// Public by default; no auth gate because bundles contain no secrets (they
// run in the user's browser and fetch data via the already-authed /api routes).
app.route('/renderer', rendererRouter);
app.route('/api/deploy-waitlist', deployWaitlistRouter);
// W2.1: per-user state
app.route('/api/memory', memoryRouter);
app.route('/api/secrets', secretsRouter);
// W2.3: Composio OAuth connections (for /build Connect-a-tool ramp)
app.route('/api/connections', connectionsRouter);
// W3.1: workspaces + members + invites + session
app.route('/api/workspaces', workspacesRouter);
app.route('/api/session', sessionRouter);
// W3.3: Stripe Connect partner app (creator monetization). The /webhook
// endpoint inside this router is intentionally Stripe-authenticated (via
// signature verification) rather than gated by FLOOM_AUTH_TOKEN — Stripe
// can't send a Bearer token. The other routes flow through the normal
// /api global auth gate registered above.
app.route('/api/stripe', stripeRouter);
// W4-minimal: per-user run history, reviews, product feedback. /api/me
// owns the scoped dashboard queries; /api/apps/:slug/reviews powers the
// /p/:slug review surface; /api/feedback accepts in-app feedback.
app.route('/api/me', meRouter);
app.route('/api/apps', reviewsRouter);
app.route('/api/feedback', feedbackRouter);

// W3.1: when FLOOM_CLOUD_MODE=true, mount the Better Auth handler on /auth/*.
// In OSS mode (the default), `getAuth()` returns null and this block is a
// no-op. The handler owns its own basePath ("/auth") so we mount under "/" with
// a wildcard. Better Auth handles every method itself.
if (isCloudMode()) {
  const auth = getAuth();
  if (auth) {
    // Hono `app.on(...)` accepts a method list + path. Better Auth's
    // `handler` consumes the raw `Request` and returns a `Response`, which
    // is exactly what `c.req.raw` and `c.body()` provide.
    app.on(
      ['GET', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
      '/auth/*',
      (c) => auth.handler(c.req.raw),
    );
    console.log('[auth] FLOOM_CLOUD_MODE=true — Better Auth mounted at /auth/*');
  }
}

// Tiny, hand-written OpenAPI 3 document describing Floom's own admin API.
// Returned at /openapi.json so users hitting http://host/openapi.json get
// something useful instead of the SPA index.html.
app.get('/openapi.json', (c) =>
  c.json({
    openapi: '3.0.0',
    info: {
      title: 'Floom self-host API',
      version: '0.4.0-mvp.4',
      description:
        'Floom exposes three admin endpoints plus per-app run and MCP surfaces. For per-app tool schemas, call /api/hub and inspect each app manifest, or use the MCP tools/list over /mcp/app/:slug. v0.3.1 adds per-user app memory (/api/memory) and an encrypted secrets vault (/api/secrets). v0.3.2 adds Composio-backed OAuth connections (/api/connections). v0.4.0-alpha.2 adds the Stripe Connect partner-app surface (/api/stripe/*) with Express onboarding, direct charges with a 5% application fee, refunds, subscriptions, and webhook receiver. v0.4.0-alpha.3 (W3.1) adds workspaces + members + invites (/api/workspaces) and the session API (/api/session) wired to Better Auth in cloud mode. v0.4.0-minimal (W4-minimal) adds /api/me/runs, /api/hub/ingest, /api/apps/:slug/reviews, and /api/feedback for the end-to-end product UI. v0.4.0-minimal.2 adds seven deterministic fast utility apps (uuid, password, hash, base64, json-format, jwt-decode, word-count) bundled as a proxied Node sidecar, and the data-driven store sort (featured DESC, avg_run_ms ASC). v0.4.0-minimal.5 (W4M gap close) wires /auth/update-user + /auth/change-password + /auth/delete-user into /me/settings, runs Better Auth migrations on boot in cloud mode, and passes the resolved session context into dispatchRun so per-user secrets resolve for authenticated runs. v0.4.0-minimal.6 (polish pass) adds DM Serif Display to hero + section headings, adds a 9-item sidebar on /me with coming-soon stubs for Folders, Saved results, Schedules, My tickets, Shared, and adds Add-to-ChatGPT + Add-to-Notion coming-soon modals on app permalinks. v0.4.0-mvp (UI strip) defers the workspace switcher and Composio connections UI to feature branches while keeping all backend routes live; see docs/DEFERRED-UI.md for the full re-enable path.',
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
      '/api/memory/{app_slug}': {
        get: {
          summary: 'List per-user memory keys for an app',
          parameters: [
            { name: 'app_slug', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'JSON {entries: {...}}' } },
        },
        post: {
          summary: 'Upsert a per-user memory key (must be declared in manifest.memory_keys)',
          parameters: [
            { name: 'app_slug', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: '{ok: true}' },
            '403': { description: 'Key not in manifest.memory_keys' },
          },
        },
      },
      '/api/secrets': {
        get: {
          summary: 'List masked per-user secrets (never returns plaintext)',
          responses: { '200': { description: 'JSON {entries: [{key, updated_at}]}' } },
        },
        post: {
          summary: 'Upsert an encrypted per-user secret',
          responses: { '200': { description: '{ok: true}' } },
        },
      },
      '/api/connections': {
        get: {
          summary: 'List Composio-backed OAuth connections for the current caller',
          parameters: [
            {
              name: 'status',
              in: 'query',
              required: false,
              schema: {
                type: 'string',
                enum: ['pending', 'active', 'revoked', 'expired'],
              },
            },
          ],
          responses: {
            '200': { description: 'JSON {connections: [...]}' },
          },
        },
      },
      '/api/connections/initiate': {
        post: {
          summary: 'Kick off a Composio OAuth flow for a provider',
          responses: {
            '200': {
              description: '{auth_url, connection_id, provider, expires_at}',
            },
            '400': { description: 'Missing or misconfigured provider' },
            '502': { description: 'Composio upstream failure' },
          },
        },
      },
      '/api/connections/finish': {
        post: {
          summary: 'Poll Composio and finalize a pending connection',
          responses: {
            '200': { description: '{connection: serialized}' },
            '404': { description: 'No such connection for caller' },
          },
        },
      },
      '/api/connections/{provider}': {
        delete: {
          summary: 'Revoke a Composio connection for a provider',
          parameters: [
            {
              name: 'provider',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': { description: '{ok: true, connection: serialized}' },
            '404': { description: 'No such connection' },
          },
        },
      },
      '/api/stripe/connect/onboard': {
        post: {
          summary: 'Create a Stripe Connect Express account and return an onboarding link',
          responses: {
            '200': {
              description:
                '{account_id, onboarding_url, expires_at, account: {...}}',
            },
            '400': { description: 'Stripe not configured or invalid body' },
            '502': { description: 'Stripe upstream failure' },
          },
        },
      },
      '/api/stripe/connect/status': {
        get: {
          summary: 'Return the caller Stripe account capabilities (charges_enabled etc.)',
          parameters: [
            {
              name: 'refresh',
              in: 'query',
              required: false,
              schema: { type: 'boolean' },
              description: 'When false, returns cached row without polling Stripe.',
            },
          ],
          responses: {
            '200': { description: '{account: {...}}' },
            '404': { description: 'Caller has not onboarded yet' },
          },
        },
      },
      '/api/stripe/payments': {
        post: {
          summary:
            'Create a direct charge on the caller connected account with a 5% application fee',
          responses: {
            '200': {
              description:
                '{payment_intent_id, client_secret, amount, currency, application_fee_amount, status, destination}',
            },
            '400': { description: 'Invalid body' },
            '404': { description: 'Caller has not onboarded yet' },
            '502': { description: 'Stripe upstream failure' },
          },
        },
      },
      '/api/stripe/refunds': {
        post: {
          summary:
            'Refund a payment intent. Auto-refunds the 5% application fee if within 30 days.',
          responses: {
            '200': {
              description:
                '{refund_id, amount, currency, status, application_fee_refunded}',
            },
            '400': { description: 'Invalid body' },
            '404': { description: 'Caller has not onboarded yet' },
            '502': { description: 'Stripe upstream failure' },
          },
        },
      },
      '/api/stripe/subscriptions': {
        post: {
          summary:
            'Create a subscription on the caller connected account with a 5% application_fee_percent',
          responses: {
            '200': {
              description:
                '{subscription_id, customer_id, status, application_fee_percent, destination, item_id}',
            },
            '400': { description: 'Invalid body' },
            '404': { description: 'Caller has not onboarded yet' },
            '502': { description: 'Stripe upstream failure' },
          },
        },
      },
      '/api/stripe/webhook': {
        post: {
          summary:
            'Stripe webhook receiver. Verifies signature, dedupes by event id, dispatches to reducers.',
          responses: {
            '200': { description: '{ok: true, first_seen, event_id, event_type}' },
            '400': { description: 'Missing or invalid Stripe-Signature header' },
          },
        },
      },
      '/api/workspaces': {
        get: {
          summary: 'List workspaces the caller is a member of',
          responses: {
            '200': { description: '{workspaces: [{id, slug, name, role, ...}]}' },
          },
        },
        post: {
          summary: 'Create a workspace; the caller becomes its admin',
          responses: {
            '201': { description: '{workspace: {...}}' },
            '400': { description: 'Invalid body shape' },
          },
        },
      },
      '/api/workspaces/{id}': {
        get: {
          summary: 'Read a single workspace (member-only)',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: '{workspace: {...}}' },
            '403': { description: 'not_a_member' },
            '404': { description: 'workspace_not_found' },
          },
        },
        patch: {
          summary: 'Update workspace name/slug (admin-only)',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: '{workspace: {...}}' },
            '403': { description: 'insufficient_role' },
          },
        },
        delete: {
          summary: 'Delete a workspace (admin-only). Refuses synthetic local.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: '{ok: true}' },
            '403': { description: 'insufficient_role' },
          },
        },
      },
      '/api/workspaces/{id}/members': {
        get: {
          summary: 'List members of a workspace',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: '{members: [{user_id, role, email, ...}]}' } },
        },
      },
      '/api/workspaces/{id}/members/invite': {
        post: {
          summary: 'Create a pending workspace invite (admin-only)',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '201': { description: '{invite: {...}, accept_url: string}' },
            '409': { description: 'duplicate_member' },
          },
        },
      },
      '/api/workspaces/{id}/members/accept-invite': {
        post: {
          summary: 'Accept a pending workspace invite using its token',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: '{member: {...}}' },
            '404': { description: 'invite_not_found' },
            '410': { description: 'invite_expired' },
          },
        },
      },
      '/api/workspaces/{id}/invites': {
        get: {
          summary: 'List invites for a workspace (admin-only)',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: '{invites: [{...}]}' } },
        },
      },
      '/api/session/me': {
        get: {
          summary: 'Composed payload: user + active workspace + memberships',
          responses: { '200': { description: '{user, active_workspace, workspaces, cloud_mode}' } },
        },
      },
      '/api/session/switch-workspace': {
        post: {
          summary: 'Set the active workspace pointer (member-only)',
          responses: {
            '200': { description: '{ok: true, active_workspace_id: string}' },
            '403': { description: 'not_a_member' },
          },
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
  const spaExcludedPrefixes = ['/api/', '/mcp', '/renderer/'];
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
  // W4-minimal gap close: run Better Auth migrations on boot when
  // FLOOM_CLOUD_MODE is enabled. Creates `user`, `session`, `account`,
  // `verification` tables plus organization + api-key tables on first
  // boot. Idempotent — subsequent boots are a no-op once tables exist.
  // Runs before seeding so any auth-dependent seed data has schemas to
  // write into. Blocks boot on failure — fail fast if the migration
  // step can't commit, rather than serving requests against a
  // half-initialized auth DB.
  if (isCloudMode()) {
    try {
      await runAuthMigrations();
    } catch (err) {
      console.error('[auth] migration failed — refusing to boot in cloud mode:', err);
      process.exit(1);
    }
  }

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

  // Fast Apps sidecar: fork examples/fast-apps/server.mjs and ingest its
  // seven deterministic utility apps. Opt-out via FLOOM_FAST_APPS=false.
  // Merged from wave/W4M-fast-apps (0.4.0-minimal.2) into wave/W4M-test-fixes
  // so the published image has both gap-close auth migrations AND the fast-
  // apps sidecar.
  startFastApps().catch((err) => {
    console.error('[fast-apps] boot failed:', err);
  });

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[server] listening on http://localhost:${info.port}`);
    console.log(`[server] public url: ${PUBLIC_URL}`);
  });
}

boot();
