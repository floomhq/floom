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
import { meAppsRouter } from './routes/me_apps.js';
import { metricsRouter } from './routes/metrics.js';
import { ogRouter } from './routes/og.js';
import { db } from './db.js';
import { SERVER_VERSION } from './lib/server-version.js';
import { initSentry, captureServerError } from './lib/sentry.js';
import { seedFromFile } from './services/seed.js';
import { ingestOpenApiApps } from './services/openapi-ingest.js';
import { startFastApps } from './services/fast-apps-sidecar.js';
import { backfillAppEmbeddings } from './services/embeddings.js';
import { globalAuthMiddleware } from './lib/auth.js';
import { getAuth, isCloudMode, runAuthMigrations } from './lib/better-auth.js';
import { runRateLimitMiddleware } from './lib/rate-limit.js';
import { resolveUserContext } from './services/session.js';
import { startJobWorker } from './services/worker.js';
import { startTriggersWorker } from './services/triggers-worker.js';
import { securityHeaders } from './middleware/security.js';
import { meTriggersRouter, hubTriggersRouter } from './routes/triggers.js';
import { webhookRouter } from './routes/webhook.js';

const PORT = Number(process.env.PORT || 3051);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Optional Sentry wiring. No-op when SENTRY_DSN is unset.
initSentry();

const app = new Hono();
app.use('*', logger());

// CORS (2026-04-20 security audit P2): split policy.
//
// Restricted routes (auth/cookie-bearing): /auth/*, /api/me/*, /api/session/*,
// /api/workspaces/*, /api/connections/*, /api/memory/*, /api/secrets/*,
// /api/hub admin mutations (POST/PATCH/DELETE on /api/hub). These get an
// allow-listed origin + credentials.
//
// Open routes (public, credential-less server-to-server calls from MCP
// clients, Zapier, Make, user scripts): /api/:slug/run, /api/:slug/jobs,
// GET /api/hub, GET /api/hub/:slug, /mcp/*, /og/*, /renderer/*. These get
// `origin: '*'` but NO credentials so a cookie can't ride along.
//
// We build a single allow-list up front and pick the right CORS config per
// route group below.
const trustedOrigins = [
  process.env.PUBLIC_URL, // https://preview.floom.dev or https://floom.dev
  'https://preview.floom.dev',
  'https://floom.dev',
  'https://app.floom.dev', // future prod alias
  ...(process.env.NODE_ENV !== 'production'
    ? ['http://localhost:5173', 'http://localhost:3051']
    : []),
].filter((o): o is string => Boolean(o));

const restrictedCors = cors({
  origin: (origin) => {
    if (!origin) return ''; // same-origin, no CORS header needed
    return trustedOrigins.includes(origin) ? origin : '';
  },
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
});

// Open CORS for public run/hub/MCP surfaces. No credentials so cookies don't
// ride along — server-to-server callers should use bearer tokens.
const openCors = cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'Accept'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
});

// Restricted paths first (auth/cookie surfaces).
app.use('/auth/*', restrictedCors);
app.use('/api/me/*', restrictedCors);
app.use('/api/session/*', restrictedCors);
app.use('/api/workspaces/*', restrictedCors);
app.use('/api/connections/*', restrictedCors);
app.use('/api/memory/*', restrictedCors);
app.use('/api/secrets/*', restrictedCors);
app.use('/api/stripe/*', restrictedCors);
app.use('/api/feedback/*', restrictedCors);

// Open surfaces (public read/run, MCP, OG, renderer bundles).
app.use('/api/hub/*', openCors);
app.use('/api/hub', openCors);
app.use('/api/health/*', openCors);
app.use('/api/run', openCors);
app.use('/api/:slug/run', openCors);
app.use('/api/:slug/jobs', openCors);
app.use('/mcp/*', openCors);
app.use('/mcp', openCors);
app.use('/og/*', openCors);
app.use('/renderer/*', openCors);

// P1 security headers: CSP + HSTS + nosniff + Referrer-Policy.
// Mounted before routes so it wraps every response. Routes that own a
// tighter CSP (renderer frame) are exempted inside the middleware.
app.use('*', securityHeaders);

// Global error handler: forward uncaught exceptions to Sentry (if wired) and
// surface a generic 500 to the caller. Hono's onError fires for any thrown
// error that reaches the top of the router stack.
app.onError((err, c) => {
  captureServerError(err, { path: new URL(c.req.url).pathname, method: c.req.method });
  console.error('[server] unhandled error:', err);
  return c.json({ error: 'internal_server_error' }, 500);
});
process.on('unhandledRejection', (reason) => {
  captureServerError(reason);
  console.error('[server] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  captureServerError(err);
  console.error('[server] uncaughtException:', err);
});
// Global auth gate: if FLOOM_AUTH_TOKEN is set, every API/MCP/p route
// requires a matching bearer token. /api/health is always open so health
// probes work. If the env var is unset, this is a no-op.
app.use('/api/*', globalAuthMiddleware);
app.use('/mcp/*', globalAuthMiddleware);
app.use('/p/*', globalAuthMiddleware);
if (process.env.FLOOM_AUTH_TOKEN) {
  console.log('[auth] FLOOM_AUTH_TOKEN is set — bearer auth required on all /api, /mcp, /p routes');
}

// Rate limiting for run surfaces. Applied to POST-heavy paths that actually
// execute an app. Health / hub list / /me/runs / MCP tools/list stay
// unthrottled so frontend polls and service discovery aren't affected.
// Routes covered:
//   - POST /api/run               (body-keyed slug, legacy)
//   - POST /api/:slug/run         (slug-keyed, primary for paste-first)
//   - POST /api/:slug/jobs        (async enqueue)
//   - POST /mcp/app/:slug         (per-app MCP tool calls)
// The MCP admin root (/mcp) is rate-limited separately inside the tool
// handler (ingest_app only, 10/day).
const rateLimit = runRateLimitMiddleware(resolveUserContext);
app.use('/api/run', rateLimit);
app.use('/api/:slug/run', rateLimit);
app.use('/api/:slug/jobs', rateLimit);
app.use('/mcp/app/:slug', rateLimit);

// API routes
app.route('/api/health', healthRouter);
// Prometheus-style metrics. Exempt from the global auth gate above; metrics
// owns its own METRICS_TOKEN bearer auth. 404 when the env var is unset.
app.route('/api/metrics', metricsRouter);
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
// Dynamic social preview images for /p/:slug and the main landing.
// Public, no auth. See routes/og.ts for format details.
app.route('/og', ogRouter);
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
// Secrets-policy feature: creator + viewer surface for per-app secret
// policies and creator-owned secret values. Mounted at /api/me/apps so
// the URL scheme reads as "this caller's relationship to :slug".
app.route('/api/me/apps', meAppsRouter);
// Unified triggers (schedule + webhook). `/api/me/triggers` is the caller's
// list; create is under `/api/hub/:slug/triggers` so the owner-check reuses
// the hub router pattern. See routes/triggers.ts for the full surface.
app.route('/api/me/triggers', meTriggersRouter);
app.route('/api/hub', hubTriggersRouter);
// Incoming webhook dispatch. Public, signature-verified. Mounted outside
// `/api/*` so the global FLOOM_AUTH_TOKEN bearer-auth middleware doesn't
// block external senders. HMAC signature is the auth. See routes/webhook.ts.
app.route('/hook', webhookRouter);
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
      version: SERVER_VERSION,
      description:
        'Floom lists registered apps at GET /api/hub. Each app is callable over MCP at /mcp/app/{slug} and via HTTP POST /api/{slug}/run; use each app manifest for tool names and parameters. When enabled, POST /mcp exposes admin tools (ingest_app, list_apps, search_apps, get_app) for ingest and discovery without the web UI. Optional routes depend on deployment: per-user memory (/api/memory), encrypted secrets (/api/secrets), OAuth connections (/api/connections), Stripe Connect (/api/stripe), workspaces (/api/workspaces), session (/api/session). Product UI for some features may be deferred; backend routes may still exist. Rate limits apply to run surfaces unless disabled (FLOOM_RATE_LIMIT_DISABLED=true); see docs/SELF_HOST.md#rate-limits.',
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
          summary: 'List OAuth tool connections for the current caller',
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
          summary: 'Kick off an OAuth connection flow for a provider',
          responses: {
            '200': {
              description: '{auth_url, connection_id, provider, expires_at}',
            },
            '400': { description: 'Missing or misconfigured provider' },
            '502': { description: 'OAuth provider upstream failure' },
          },
        },
      },
      '/api/connections/finish': {
        post: {
          summary: 'Poll upstream and finalize a pending connection',
          responses: {
            '200': { description: '{connection: serialized}' },
            '404': { description: 'No such connection for caller' },
          },
        },
      },
      '/api/connections/{provider}': {
        delete: {
          summary: 'Revoke a connection for a provider',
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
      '/mcp': {
        post: {
          summary: 'MCP admin surface (ingest_app, list_apps, search_apps, get_app)',
          description:
            'Four admin tools for gallery management and app creation. ingest_app accepts openapi_url or inline openapi_spec; list_apps supports category + keyword filters; search_apps runs semantic search (keyword fallback); get_app returns the full manifest for a slug. ingest_app requires authentication in Cloud mode; read tools are public.',
          responses: { '200': { description: 'JSON-RPC 2.0 response' } },
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
  //
  // /auth/ must be excluded so Better Auth's OAuth redirect handler
  // (/auth/sign-in/social, /auth/callback/*) isn't served as index.html —
  // which rendered a blank page instead of triggering the Google/GitHub
  // redirect. Fix for blank-page on social sign-in reported post-launch.
  const spaExcludedPrefixes = ['/api/', '/mcp', '/renderer/', '/og/', '/hook/', '/auth/'];
  const spaExcludedExact = new Set(['/openapi.json', '/metrics']);

  // Crawlers don't run JS, so client-side meta updates in AppPermalinkPage
  // never reach them. For /p/:slug we rewrite the og:image, og:title,
  // og:description (+ twitter equivalents) in the served HTML so previewers
  // see the per-app card.
  const pSlugPattern = /^\/p\/([a-z0-9][a-z0-9-]*)\/?$/;
  const publicOrigin = process.env.PUBLIC_ORIGIN || PUBLIC_URL || '';
  const defaultOgImage = `${publicOrigin}/og-image.png`;

  // 2026-04-20 (P2 #149): SSR title drift. Previously every route returned
  // the same landing <title> at SSR because client-side `document.title`
  // updates don't reach non-JS crawlers (social previewers, SEO bots,
  // curl/wget). Rewrite the <title> tag per-route in the same middleware
  // that already handles /p/:slug OG rewriting.
  const LANDING_TITLE = 'Ship AI apps fast · Floom';
  function escapeTitle(t: string): string {
    // <title> is #PCDATA so only < & > really matter. We also strip newlines
    // defensively so a row with a stray \n doesn't break the document.
    return t.replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function rewriteTitle(html: string, title: string): string {
    return html.replace(/<title>[^<]*<\/title>/, `<title>${escapeTitle(title)}</title>`);
  }

  // 2026-04-20 (PRR #172): every SSR page needs a per-route canonical so
  // crawlers don't index duplicate landing-canonicalised pages. Replaces
  // whatever canonical was baked into index.html at build time.
  function rewriteCanonical(html: string, pathname: string): string {
    if (!publicOrigin) return html;
    // Nav-polish 2026-04-20: /store is an alias for /apps (same component
    // mounted at both paths). Canonicalize /store -> /apps so crawlers
    // don't index duplicates.
    const canonicalPath =
      pathname === '/store' || pathname === '/store/'
        ? '/apps'
        : pathname === '/index.html'
          ? '/'
          : pathname;
    const canonical = `${publicOrigin}${canonicalPath}`;
    return html.replace(
      /<link rel="canonical" href="[^"]*"/,
      `<link rel="canonical" href="${canonical}"`,
    );
  }

  // Map a non-slug pathname to its title. Returns null to fall through to
  // the landing title (kept for anything we haven't explicitly claimed —
  // better to reuse a known-good title than to invent a bad one).
  function titleForPath(pathname: string): string | null {
    if (pathname === '/' || pathname === '/index.html') return LANDING_TITLE;
    if (pathname === '/apps' || pathname === '/apps/') return 'Apps · Floom';
    // Nav-polish 2026-04-20: /store is mounted on the same AppsDirectoryPage
    // component as /apps (label "Store" on the TopBar pill matches the URL).
    if (pathname === '/store' || pathname === '/store/') return 'Store · Floom';
    if (pathname === '/login') return 'Sign in · Floom';
    if (pathname === '/signup') return 'Create account · Floom';
    // 2026-04-20 (PRR tail cleanup): /install is a public stub that links
    // to CLI install steps. Kept distinct from /me/install (dashboard).
    if (pathname === '/install' || pathname === '/install/') return 'Install the Floom CLI · Floom';
    // 2026-04-20 (about-page ship): /about is a real story page now (not
    // a redirect to landing). Per-route SSR title so crawlers + social
    // previews see the About title, not the landing title.
    if (pathname === '/about' || pathname === '/about/') {
      return 'About Floom · Get that thing off localhost fast';
    }
    // /onboarding is a redirect to /me?welcome=1 but the title the server
    // returns before the 302 hops still matters for preview bots.
    if (pathname === '/onboarding' || pathname === '/onboarding/') return 'Welcome to Floom · Floom';
    if (pathname === '/me' || pathname.startsWith('/me/')) return 'Me · Floom';
    if (pathname.startsWith('/studio')) return 'Studio · Floom';
    if (pathname.startsWith('/docs')) return 'Docs · Floom';
    if (pathname === '/protocol' || pathname.startsWith('/protocol/') || pathname.startsWith('/protocol#')) {
      return 'The Floom Protocol · Floom';
    }
    if (pathname.startsWith('/r/')) return 'Run · Floom';
    if (pathname === '/imprint') return 'Imprint · Floom';
    if (pathname === '/privacy') return 'Privacy · Floom';
    if (pathname === '/terms') return 'Terms · Floom';
    if (pathname === '/cookies') return 'Cookies · Floom';
    return null;
  }

  function rewriteHeadForLanding(html: string): string {
    let out = html;
    out = rewriteTitle(out, LANDING_TITLE);
    out = out.replace(
      /<link rel="canonical" href="[^"]*"/,
      `<link rel="canonical" href="${publicOrigin}/"`,
    );
    out = out.replace(
      /<meta property="og:url" content="[^"]*"/,
      `<meta property="og:url" content="${publicOrigin}/"`,
    );
    out = out.replace(
      /<meta property="og:image" content="[^"]*"/,
      `<meta property="og:image" content="${defaultOgImage}"`,
    );
    out = out.replace(
      /<meta name="twitter:image" content="[^"]*"/,
      `<meta name="twitter:image" content="${defaultOgImage}"`,
    );
    out = out.replace(
      /"url":\s*"[^"]*"/,
      `"url": "${publicOrigin}/"`,
    );
    return out;
  }

  function rewriteHeadForPath(html: string, pathname: string): string {
    let out = rewriteCanonical(html, pathname);
    const title = titleForPath(pathname);
    if (title) out = rewriteTitle(out, title);
    // 2026-04-20 (about-page ship): the SPA fallback + <noscript> block in
    // index.html bake the landing H1 ("Production infrastructure for AI
    // apps that do real work."). Crawlers + curl-based verification read
    // the HTML before JS runs, so every page returned the landing H1.
    // For /about we rewrite the fallback copy to the About hero so the
    // page has a truthful H1 pre-hydrate. Kept narrow (this one route)
    // to avoid ripple with the parallel H1-swap work on /.
    if (pathname === '/about' || pathname === '/about/') {
      const aboutH1 = 'Get that thing off localhost fast.';
      const aboutSub =
        "Floom exists for one reason: to turn your code into a real app with a real URL so other people can actually use it.";
      out = out.replace(
        /<div style="display:none" data-spa-fallback>[\s\S]*?<\/div>/,
        `<div style="display:none" data-spa-fallback>\n        <h1>${aboutH1}</h1>\n        <p>${aboutSub}</p>\n        <p><a href="/studio/build">Paste your thing</a> &middot; <a href="/">Home</a></p>\n      </div>`,
      );
      out = out.replace(
        /<noscript>[\s\S]*?<\/noscript>/,
        `<noscript>\n      <h1>${aboutH1}</h1>\n      <p>${aboutSub}</p>\n      <p><a href="/studio/build">Paste your thing</a> &middot; <a href="/">Home</a></p>\n    </noscript>`,
      );
    }
    return out;
  }

  function rewriteHeadForSlug(html: string, slug: string): string {
    const row = db
      .prepare('SELECT name, description FROM apps WHERE slug = ?')
      .get(slug) as { name: string | null; description: string | null } | undefined;
    const ogImage = `${publicOrigin}/og/${slug}.svg`;
    // 2026-04-20 (PRR #172): canonical per-slug so indexers don't fold
    // every /p/:slug back to the landing canonical.
    let out = rewriteCanonical(html, `/p/${slug}`);
    out = out.replace(
      /<meta property="og:image" content="[^"]*"/,
      `<meta property="og:image" content="${ogImage}"`,
    );
    out = out.replace(
      /<meta name="twitter:image" content="[^"]*"/,
      `<meta name="twitter:image" content="${ogImage}"`,
    );
    if (row?.name) {
      // 2026-04-20 (P2 #149): also rewrite the document <title> so
      // non-JS crawlers see `{app_name} · Floom` for /p/:slug.
      const documentTitle = `${row.name} · Floom`;
      out = rewriteTitle(out, documentTitle);
      const title = `${row.name} | Floom`;
      out = out.replace(
        /<meta property="og:title" content="[^"]*"/,
        `<meta property="og:title" content="${title.replace(/"/g, '&quot;')}"`,
      );
      out = out.replace(
        /<meta name="twitter:title" content="[^"]*"/,
        `<meta name="twitter:title" content="${title.replace(/"/g, '&quot;')}"`,
      );
    } else {
      // Slug didn't resolve in the DB; don't dangle the landing title on
      // what is effectively a 404-ish page. Use a generic app title.
      out = rewriteTitle(out, 'App · Floom');
    }
    if (row?.description) {
      const desc = row.description.replace(/"/g, '&quot;').slice(0, 300);
      out = out.replace(
        /<meta property="og:description" content="[^"]*"/,
        `<meta property="og:description" content="${desc}"`,
      );
      out = out.replace(
        /<meta name="twitter:description" content="[^"]*"/,
        `<meta name="twitter:description" content="${desc}"`,
      );
    }
    out = out.replace(
      /<meta property="og:url" content="[^"]*"/,
      `<meta property="og:url" content="${publicOrigin}/p/${slug}"`,
    );
    return out;
  }

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

    if (pathname === '/' || pathname === '/index.html') {
      return new Response(rewriteHeadForLanding(indexHtml), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        },
      });
    }

    // 2026-04-20 (PRR tail cleanup): /spec and /spec/* were linked from the
    // wireframes/sitemap but returned 404 because the real route is /protocol.
    // Redirect every /spec/* (including /spec/protocol.md) to /protocol so
    // old deep links and drafts stop breaking.
    if (pathname === '/spec' || pathname === '/spec/' || pathname.startsWith('/spec/')) {
      const suffix = pathname.replace(/^\/spec\/?/, '');
      // Strip a trailing `.md` so /spec/protocol.md lands on /protocol (not
      // /protocol.md which would 404 again).
      const cleaned = suffix.replace(/\.md$/i, '');
      const target = cleaned ? `/protocol#${cleaned}` : '/protocol';
      return new Response(null, {
        status: 308,
        headers: { location: target, 'cache-control': 'public, max-age=3600' },
      });
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
            : ext === 'ico'
            ? 'image/x-icon'
            : ext === 'xml'
            ? 'application/xml; charset=utf-8'
            : ext === 'txt'
            ? 'text/plain; charset=utf-8'
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

    // SPA fallback — return index.html for non-file routes. For /p/:slug
    // we rewrite the OG meta tags so crawlers see the per-app card.
    // 2026-04-20 (P2 #149): for everything else, rewrite the <title> so
    // non-JS crawlers see the right per-route title instead of the
    // landing title on every page. Also rewrite canonical per-route
    // (PRR #172).
    const slugMatch = pathname.match(pSlugPattern);
    if (slugMatch && slugMatch[1]) {
      return c.html(rewriteHeadForSlug(indexHtml, slugMatch[1]));
    }
    // 2026-04-20 (PRR tail cleanup): explicit /404 path returns 404 status
    // (the React Router wildcard renders NotFoundPage at 200 for all other
    // unknown routes — a deeper fix but out of scope for this PR).
    if (pathname === '/404' || pathname === '/404.html') {
      return new Response(
        rewriteTitle(rewriteCanonical(indexHtml, pathname), 'Page not found · Floom'),
        {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
        },
      );
    }
    return c.html(rewriteHeadForPath(indexHtml, pathname));
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
    // Await so the docker-image-availability probe runs before the hub
    // serves its first /api/hub request. Without await, a fast client
    // could hit the hub before any inactive-marking SQL landed and see
    // seed apps whose images aren't actually on this host.
    await seedFromFile();
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

  // Start the triggers scheduler. Polls the `triggers` table every 30s
  // and enqueues jobs for schedule-type triggers whose next_run_at has
  // arrived. Opt-out via FLOOM_DISABLE_TRIGGERS_WORKER=true for tests.
  if (process.env.FLOOM_DISABLE_TRIGGERS_WORKER !== 'true') {
    startTriggersWorker();
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
