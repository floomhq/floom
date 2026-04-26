import './lib/sentry-init.js';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import { logger } from 'hono/logger';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adminRouter } from './routes/admin.js';
import { accountDeleteRouter } from './routes/account_delete.js';
import { healthRouter } from './routes/health.js';
import { hubRouter } from './routes/hub.js';
import { parseRouter } from './routes/parse.js';
import { pickRouter } from './routes/pick.js';
import { threadRouter } from './routes/thread.js';
import { runRouter, slugRunRouter, slugQuotaRouter, meRouter } from './routes/run.js';
import { jobsRouter } from './routes/jobs.js';
import { mcpRouter } from './routes/mcp.js';
import { rendererRouter } from './routes/renderer.js';
import { waitlistRouter } from './routes/waitlist.js';
import { memoryRouter, secretsRouter } from './routes/memory.js';
import { connectionsRouter } from './routes/connections.js';
import { workspacesRouter, sessionRouter } from './routes/workspaces.js';
import { stripeRouter } from './routes/stripe.js';
import { reviewsRouter } from './routes/reviews.js';
import { feedbackRouter } from './routes/feedback.js';
import { meAppsRouter } from './routes/me_apps.js';
import { agentKeysRouter } from './routes/agent_keys.js';
import { agentsRouter } from './routes/agents.js';
import { metricsRouter } from './routes/metrics.js';
import { ogRouter } from './routes/og.js';
import { ghStarsRouter } from './routes/gh-stars.js';
import { skillRouter } from './routes/skill.js';
import { studioBuildRouter } from './routes/studio-build.js';
import { db } from './db.js';
import { SERVER_VERSION } from './lib/server-version.js';
import { captureServerError } from './lib/sentry.js';
import { enforceStartupChecks } from './lib/startup-checks.js';
import { sendDiscordAlert, logAlertsBootState } from './lib/alerts.js';
import { seedFromFile } from './services/seed.js';
import { seedLaunchDemos } from './services/launch-demos.js';
import { ingestOpenApiApps } from './services/openapi-ingest.js';
import { startFastApps } from './services/fast-apps-sidecar.js';
import { backfillAppEmbeddings } from './services/embeddings.js';
import { globalAuthMiddleware } from './lib/auth.js';
import { agentTokenAuthMiddleware } from './lib/agent-tokens.js';
import {
  getAuth,
  getAuthForRequest,
  isCloudMode,
  purgeUnverifiedAuthSessions,
  runAuthMigrations,
} from './lib/better-auth.js';
import { sanitizeAuthResponse } from './lib/auth-response.js';
import { padToFloor, shouldPadAuthTiming } from './lib/auth-response-guard.js';
import { runRateLimitMiddleware, writeRateLimitMiddleware } from './lib/rate-limit.js';
import {
  applyProgressiveSigninDelayFromContext,
  parseEmailForSigninProgressiveDelay,
  recordSigninEmailProgressiveDelayOutcome,
} from './lib/signin-progressive-delay.js';
import { resolveUserContext } from './services/session.js';
import { getAppAccessDecision, isPublicListingVisibility } from './services/sharing.js';
import { startJobWorker } from './services/worker.js';
import { startTriggersWorker } from './services/triggers-worker.js';
import { startGithubBuildWorker } from './services/github-deploy.js';
import { sweepZombieRuns, startZombieRunSweeper } from './services/runner.js';
import { startRunRetentionSweeper } from './services/run-retention-sweeper.js';
import { startAuditLogRetentionSweeper } from './services/audit-log.js';
import { securityHeaders, noIndexPreview, isPreviewEnv } from './middleware/security.js';
import { runBodyLimit } from './middleware/body-size.js';
import { meTriggersRouter, hubTriggersRouter } from './routes/triggers.js';
import { webhookRouter } from './routes/webhook.js';
import { isDeployEnabled } from './services/workspaces.js';
import {
  AccountDeleteError,
  getUserDeletionStateByEmail,
  initiateAccountSoftDelete,
  isDeleteExpired,
  permanentlyDeleteExpiredAccountForEmail,
  revokeAccountSessions,
  softDeletedSignInBody,
  startAccountDeleteSweeper,
} from './services/account-deletion.js';

const PORT = Number(process.env.PORT || 3051);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

enforceStartupChecks();

// Optional Discord alerts. No-op when DISCORD_ALERTS_WEBHOOK_URL is unset.
// Logs one line at boot so operators can verify wiring via docker logs.
logAlertsBootState();

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

const restrictedCorsInner = cors({
  origin: (origin) => {
    if (!origin) return ''; // same-origin, no CORS header needed
    return trustedOrigins.includes(origin) ? origin : '';
  },
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
});

/**
 * Pentest LOW #385 — gate `Access-Control-Allow-Credentials: true` on an
 * actual `Access-Control-Allow-Origin` match.
 *
 * Hono's `cors({ credentials: true, ... })` always stamps ACAC=true on
 * every response regardless of whether the request `Origin` ended up in
 * our trusted list. Browsers only honour ACAC when ACAO is also set, so
 * the header was functionally inert on untrusted origins — but the
 * pentest flagged it as a landmine: a future tweak that reflects
 * `Origin` blindly (or allows `*`) would silently open cross-origin
 * credentialed fetches. Strip ACAC whenever ACAO didn't make it onto
 * the response so there's never a dangling `credentials=true` header.
 */
const restrictedCors: MiddlewareHandler = async (c, next) => {
  const maybeResponse = await restrictedCorsInner(c, next);
  const headers = maybeResponse ? maybeResponse.headers : c.res.headers;
  if (!headers.get('Access-Control-Allow-Origin')) {
    headers.delete('Access-Control-Allow-Credentials');
  }
  return maybeResponse;
};

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
app.use('/api/studio/build/*', restrictedCors);
// Admin surface is bearer-authed; same CORS policy as other restricted routes
// so a misconfigured cross-origin page can't call it with credentials.
app.use('/api/admin/*', restrictedCors);

// Open surfaces (public read/run, MCP, OG, renderer bundles).
app.use('/api/hub/*', openCors);
app.use('/api/hub', openCors);
app.use('/api/health/*', openCors);
// GH stars proxy — public read-only, no credentials.
app.use('/api/gh-stars', openCors);
app.use('/api/gh-stars/*', openCors);
app.use('/api/run', openCors);
app.use('/api/agents', openCors);
app.use('/api/agents/*', openCors);
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

// SEO #596: emit `X-Robots-Tag: noindex, nofollow` on every response from
// preview deployments (PUBLIC_URL contains `preview.`) so Google never
// indexes preview.floom.dev and creates duplicate-content competition for
// the prod floom.dev URLs. Prod is a no-op.
app.use('*', noIndexPreview);

// Global error handler: forward uncaught exceptions to Sentry (if wired) and
// surface a generic 500 to the caller. Hono's onError fires for any thrown
// error that reaches the top of the router stack.
app.onError((err, c) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  captureServerError(err, { path, method });
  // Discord alert on 5xx. The helper is rate-limited per-title so a
  // regression storm collapses to one ping / minute / error class.
  // Using `err.name` as the title groups "TypeError", "DbError", etc.
  // and leaves room for the path in the body.
  const name = (err as { name?: string })?.name || 'Error';
  const message = (err as { message?: string })?.message || String(err);
  sendDiscordAlert(
    `Floom 5xx: ${name}`,
    '```\n' + message + '\n```',
    { path, method },
  );
  console.error('[server] unhandled error:', err);
  return c.json({ error: 'internal_server_error' }, 500);
});
process.on('unhandledRejection', (reason) => {
  captureServerError(reason);
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : JSON.stringify(reason);
  sendDiscordAlert('Floom unhandledRejection', '```\n' + String(message).slice(0, 500) + '\n```');
  console.error('[server] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  captureServerError(err);
  sendDiscordAlert(
    'Floom uncaughtException',
    '```\n' + (err?.message || String(err)).slice(0, 500) + '\n```',
  );
  console.error('[server] uncaughtException:', err);
});
// Global auth gate: if FLOOM_AUTH_TOKEN is set, every API/MCP/p route
// requires a matching bearer token. /api/health is always open so health
// probes work. If the env var is unset, this is a no-op.
app.use('/api/*', globalAuthMiddleware);
app.use('/mcp/*', globalAuthMiddleware);
app.use('/p/*', globalAuthMiddleware);
app.use('/api/*', agentTokenAuthMiddleware);
app.use('/mcp/*', agentTokenAuthMiddleware);
app.use('/p/*', agentTokenAuthMiddleware);
if (process.env.FLOOM_AUTH_TOKEN) {
  console.log('[auth] FLOOM_AUTH_TOKEN is set — bearer auth required on all /api, /mcp, /p routes');
}

// Rate limiting for run surfaces. Direct run handlers call the shared
// runGate helper after they know the target slug; queued jobs and HTTP ingest
// still use middleware because the route path carries their budget identity.
// Routes covered:
//   - POST /api/:slug/jobs        (async enqueue)
//   - POST /api/hub/ingest        (HTTP ingest; MCP ingest_app has its own daily cap)
//   - POST /mcp and /mcp/* body-size guard (run_app rate gates inline)
const rateLimit = runRateLimitMiddleware(resolveUserContext);
const writeRateLimit = writeRateLimitMiddleware(resolveUserContext);
// Body-size guard runs BEFORE the rate-limit check so an attacker can't
// burn rate-limit budget with oversized bodies (we reject 413 before
// incrementing the counter). Launch-hardening 2026-04-23 for the 3 hero
// demo apps; all run surfaces share the same 8 MiB cap. /mcp root needs the
// guard here because MCP transports parse the JSON-RPC body before a tool
// handler can inspect whether the call is run_app.
app.use('/mcp', runBodyLimit);
app.use('/mcp/*', runBodyLimit);
app.use('/api/:slug/jobs', runBodyLimit, rateLimit);
// Security H2 (audit 2026-04-23): /api/hub/ingest was the only
// unauthenticated-in-OSS write surface missing from the run-rate-limit
// umbrella. The MCP equivalent (`ingest_app` tool) already has its own
// 10/day cap via checkMcpIngestLimit, but the HTTP surface went
// uncapped. Route covers only POST (other hub paths are reads / owner-
// scoped writes and route through their own auth).
app.use('/api/hub/ingest', runBodyLimit, rateLimit);
// Security launch-week #600: global write limiter for all /api mutations.
// Existing per-route limiters are explicitly skipped inside the middleware
// to avoid double-throttling (run surfaces, feedback, waitlist).
app.use('/api/*', writeRateLimit);

// API routes
app.route('/api/health', healthRouter);
// Server-side proxy for the floomhq/floom GitHub star count. Browser
// fetches from api.github.com were getting 403-rate-limited on every
// page load (anonymous budget is 60/hour/IP). See routes/gh-stars.ts.
app.route('/api/gh-stars', ghStarsRouter);
// Admin surface (#362 publish-review gate, more to come). Every route inside
// is gated by FLOOM_AUTH_TOKEN bearer in its own middleware; if the env var
// isn't set, the router replies 404 to avoid advertising its existence.
app.route('/api/admin', adminRouter);
// Prometheus-style metrics. Exempt from the global auth gate above; metrics
// owns its own METRICS_TOKEN bearer auth. 404 when the env var is unset.
app.route('/api/metrics', metricsRouter);
app.route('/api/studio/build', studioBuildRouter);
app.route('/api/hub', hubRouter);
app.route('/api/parse', parseRouter);
app.route('/api/pick', pickRouter);
app.route('/api/thread', threadRouter);
app.route('/api/run', runRouter);
app.route('/api/agents', agentsRouter);
app.route('/mcp', mcpRouter);
// Slug-based run endpoint: POST /api/:slug/run
// Registered after /api/run to avoid prefix collision.
app.route('/api/:slug/run', slugRunRouter);
// Async job queue: POST/GET /api/:slug/jobs[/:job_id][/cancel]
app.route('/api/:slug/jobs', jobsRouter);
// Read-only BYOK quota peek: GET /api/:slug/quota
// Returns { gated, slug, usage, limit, remaining, window_ms, has_user_key_hint }
// for the 3 BYOK-gated demo slugs, or { gated: false } otherwise. Used by
// the app page's free-runs strip so the user sees "3 of 5 today" without
// having to hit POST /api/run and parse the 429 payload. No rate-limit
// middleware — this is a cheap read that shouldn't burn request budget.
app.use('/api/:slug/quota', openCors);
app.route('/api/:slug/quota', slugQuotaRouter);
// Custom renderer bundles (W2.2): GET /renderer/:slug/bundle.js + /meta
// Public by default; no auth gate because bundles contain no secrets (they
// run in the user's browser and fetch data via the already-authed /api routes).
app.route('/renderer', rendererRouter);
// Dynamic social preview images for /p/:slug and the main landing.
// Public, no auth. See routes/og.ts for format details.
app.route('/og', ogRouter);
// Deploy waitlist (launch 2026-04-27). Mounted at the canonical
// /api/waitlist and kept mounted at the legacy /api/deploy-waitlist
// so any marketing form that already POSTs to the old path keeps
// working during the cutover.
app.route('/api/waitlist', waitlistRouter);
app.route('/api/deploy-waitlist', waitlistRouter);
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
app.route('/api/me/agent-keys', agentKeysRouter);
app.route('/api/me/delete-account', accountDeleteRouter);
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
// Anthropic Skills markdown surface:
//   GET /skill.md
//   GET /p/:slug/skill.md
// Mounted before static+SPA handling so these routes never hit index.html.
app.route('/', skillRouter);

// W3.1: when FLOOM_CLOUD_MODE=true, mount the Better Auth handler on /auth/*.
// In OSS mode (the default), `getAuth()` returns null and this block is a
// no-op. The handler owns its own basePath ("/auth") so we mount under "/" with
// a wildcard. Better Auth handles every method itself.
//
// Issue #392: route every auth request through `getAuthForRequest(req)`
// instead of the singleton. This picks the Better Auth instance whose
// `baseURL` matches the caller's origin (floom.dev vs preview.floom.dev)
// so verify-email and OAuth callbacks stay on the origin host.
if (isCloudMode()) {
  const auth = getAuth();
  if (auth) {
    // OAuth error bridge: when the user denies the OAuth consent screen or
    // the provider returns an error, Better Auth redirects to
    // <baseURL>/auth/error?error=<code>. Without this handler the user sees
    // the raw backend response (plain text / Better Auth's built-in page),
    // not Floom's branded UI. Bridge it to the frontend login page.
    app.get('/auth/error', (c) => {
      const error = c.req.query('error') || 'unknown';
      const isDev = process.env.NODE_ENV !== 'production';
      const frontendOrigin =
        process.env.FLOOM_APP_URL ||
        (isDev ? 'http://localhost:5173' : '');
      if (frontendOrigin) {
        return c.redirect(
          `${frontendOrigin}/login?error=${encodeURIComponent(error)}`,
        );
      }
      return c.json({ error: 'auth_failed', code: error }, 400);
    });

    // Issue #767 (waitlist bypass): in waitlist mode (`isDeployEnabled()`
    // false), block account-creation auth endpoints before Better Auth runs.
    // Keep GET /auth/* reachable (session checks, callbacks, etc.).
    app.use('/auth/*', async (c, next) => {
      const method = c.req.method;
      const pathname = new URL(c.req.url).pathname;
      const isSignupPath = /^\/auth\/(?:sign-up|signup)(?:\/|$)/.test(pathname);
      if (method === 'POST' && isSignupPath && !isDeployEnabled()) {
        return c.json({ error: 'sign-up disabled — join the waitlist' }, 403);
      }
      return next();
    });

    app.post('/auth/delete-user', async (c) => {
      const auth = getAuthForRequest(c.req.raw);
      if (!auth) {
        return new Response('Auth not configured', { status: 503 });
      }
      const session = (await auth.api.getSession({
        headers: c.req.raw.headers,
      })) as { user?: { id: string; email: string } } | null;
      if (!session?.user?.id || !session.user.email) {
        return c.json({ error: 'Authentication required. Sign in and retry.', code: 'auth_required' }, 401);
      }
      let confirmEmail = session.user.email;
      try {
        const body = (await c.req.json()) as { confirm_email?: unknown };
        if (typeof body.confirm_email === 'string') confirmEmail = body.confirm_email;
      } catch {
        confirmEmail = session.user.email;
      }
      try {
        const result = initiateAccountSoftDelete(session.user.id, confirmEmail);
        return c.json({ success: true, message: 'User deleted', delete_at: result.delete_at });
      } catch (err) {
        if (err instanceof AccountDeleteError) {
          return c.json({ error: err.message, code: err.code }, err.status as 400 | 401 | 404 | 409 | 410 | 422);
        }
        throw err;
      }
    });

    // Hono `app.on(...)` accepts a method list + path. Better Auth's
    // `handler` consumes the raw `Request` and returns a `Response`, which
    // is exactly what `c.req.raw` and `c.body()` provide. We wrap the
    // handler so we can (a) resolve the per-origin auth instance
    // (#396 — verify-email / OAuth callbacks stay on the origin host),
    // (b) strip `token` from password-endpoint response bodies (#375), and
    // (c) pad sign-in/sign-up timing to a constant floor so email-
    // enumeration timing attacks (#376) bottom out at the same wall clock
    // on both the duplicate and fresh-user branches. See
    // lib/auth-response-guard.ts for rationale.
    app.on(
      ['GET', 'POST', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'],
      '/auth/*',
      async (c) => {
        const auth = getAuthForRequest(c.req.raw);
        if (!auth) {
          return new Response('Auth not configured', { status: 503 });
        }
        const pathname = new URL(c.req.url).pathname.replace(/\/$/, '');
        const method = c.req.method;
        let reqForAuth = c.req.raw;
        let signinEmailForDelay: string | null = null;
        let pendingDeleteSignin = null as ReturnType<typeof getUserDeletionStateByEmail> | null;
        if (method === 'POST' && pathname === '/auth/sign-in/email') {
          const bodyText = await c.req.raw.clone().text();
          const parsedEmail = parseEmailForSigninProgressiveDelay(bodyText);
          if (parsedEmail) {
            signinEmailForDelay = parsedEmail;
            await applyProgressiveSigninDelayFromContext(c, parsedEmail);
            const deletionState = getUserDeletionStateByEmail(parsedEmail);
            if (deletionState?.deleted_at) {
              if (isDeleteExpired(deletionState)) {
                const earlyStartedAtMs = Date.now();
                permanentlyDeleteExpiredAccountForEmail(parsedEmail);
                const expired = new Response(
                  JSON.stringify({
                    error: 'Invalid email or password.',
                    code: 'invalid_credentials',
                  }),
                  { status: 401, headers: { 'content-type': 'application/json' } },
                );
                await recordSigninEmailProgressiveDelayOutcome(c, parsedEmail, expired);
                const padTiming = shouldPadAuthTiming(pathname);
                if (padTiming) await padToFloor(earlyStartedAtMs);
                return expired;
              }
              pendingDeleteSignin = deletionState;
            }
            reqForAuth = new Request(c.req.raw.url, {
              method: c.req.raw.method,
              headers: c.req.raw.headers,
              body: bodyText,
            });
          }
        }
        
        const padTiming = shouldPadAuthTiming(pathname);
        const startedAtMs = padTiming ? Date.now() : 0;
        const raw = await auth.handler(reqForAuth);
        let res = await sanitizeAuthResponse(reqForAuth, raw);
        if (pendingDeleteSignin && res.status >= 200 && res.status < 300) {
          revokeAccountSessions(pendingDeleteSignin.id);
          res = new Response(JSON.stringify(softDeletedSignInBody(pendingDeleteSignin)), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (signinEmailForDelay) {
          await recordSigninEmailProgressiveDelayOutcome(c, signinEmailForDelay, res);
        }
        if (padTiming) {
          await padToFloor(startedAtMs);
        }
        return res;
      },
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
        'Floom lists registered apps at GET /api/hub. Each app is callable over MCP at /mcp/app/{slug} and via HTTP POST /api/{slug}/run; use each app manifest for tool names and parameters. When enabled, POST /mcp exposes admin tools (ingest_app, list_apps, search_apps, get_app) for ingest and discovery without the web UI. Optional routes depend on deployment: per-user memory (/api/memory), encrypted secrets (/api/secrets), OAuth connections (/api/connections), Stripe Connect (/api/stripe), workspaces (/api/workspaces), session (/api/session). Product UI for some features may be deferred; backend routes may still exist. Rate limits apply to run surfaces and /api write endpoints unless disabled (FLOOM_RATE_LIMIT_DISABLED=true); see docs/SELF_HOST.md#rate-limits.',
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
  const rawIndexHtml = readFileSync(join(webDist, 'index.html'), 'utf-8');
  // SEO #596: inject `<meta name="robots" content="noindex, nofollow">` at
  // bootstrap when running on preview so every SSR-served HTML tells
  // crawlers to skip regardless of any downstream rewrite. Belt + braces
  // with the X-Robots-Tag header set by `noIndexPreview` middleware. Prod
  // (`PUBLIC_URL=https://floom.dev`) gets the pristine HTML unchanged.
  //
  // SEO #598: also inject `<meta name="google-site-verification" ...>` on
  // prod so floom.dev can be claimed in Google Search Console. Preview is
  // noindex anyway so we intentionally skip the verification tag there —
  // there's nothing to claim on a deployment we don't want indexed. The
  // token comes from FLOOM_GSC_VERIFICATION_TOKEN; if unset, no tag is
  // injected (so the site still builds cleanly before Federico claims it).
  let indexHtml = rawIndexHtml;
  if (isPreviewEnv()) {
    indexHtml = indexHtml.replace(
      '<meta name="viewport"',
      '<meta name="robots" content="noindex, nofollow" />\n    <meta name="viewport"',
    );
    console.log('[web] preview deployment detected — injecting noindex meta + X-Robots-Tag');
  } else {
    const gscToken = (process.env.FLOOM_GSC_VERIFICATION_TOKEN || '').trim();
    if (gscToken) {
      // Double-quote sanitize so a pasted token with a stray `"` can't
      // break out of the attribute. Search Console tokens are URL-safe
      // base64-ish strings in practice, but defense is cheap.
      const safe = gscToken.replace(/"/g, '');
      indexHtml = indexHtml.replace(
        '<meta name="viewport"',
        `<meta name="google-site-verification" content="${safe}" />\n    <meta name="viewport"`,
      );
      console.log('[web] injected Google Search Console verification meta');
    }
  }

  const deployBootstrapMarker = 'data-floom-bootstrap';
  let deployBootstrapCache: string | null = null;

  function injectDeployBootstrap(html: string, _deployEnabled: boolean): string {
    if (html.includes(deployBootstrapMarker)) return html;
    const scriptTagIndex = html.search(/<script\b[^>]*\btype=["']module["'][^>]*>/i);
    if (scriptTagIndex === -1) return html;
    // `defer` keeps the fetch off the critical parsing path so CSS + the
    // module bundle can still be discovered immediately; execution is
    // ordered so the bootstrap still runs before the (implicitly deferred)
    // module bundle, priming window.__FLOOM__ before React mounts.
    const bootstrap =
      `<script defer src='/__floom/bootstrap.js' ${deployBootstrapMarker}></script>\n    `;
    return `${html.slice(0, scriptTagIndex)}${bootstrap}${html.slice(scriptTagIndex)}`;
  }

  function getIndexHtmlForDeployFlag(deployEnabled: boolean): string {
    if (deployBootstrapCache) return deployBootstrapCache;
    deployBootstrapCache = injectDeployBootstrap(indexHtml, deployEnabled);
    return deployBootstrapCache;
  }

  // Paths that must never be swallowed by the SPA wildcard. These reach
  // Hono's other route handlers or return a real 404. The order matters:
  // prefix matches first, then exact matches.
  //
  // /auth/ must be excluded so Better Auth's OAuth redirect handler
  // (/auth/sign-in/social, /auth/callback/*) isn't served as index.html —
  // which rendered a blank page instead of triggering the Google/GitHub
  // redirect. Fix for blank-page on social sign-in reported post-launch.
  const spaExcludedPrefixes = ['/api/', '/mcp', '/renderer/', '/og/', '/hook/', '/auth/'];
  const spaExcludedExact = new Set(['/openapi.json', '/metrics', '/__floom/bootstrap.js']);

  // SEO #621: known-route table for proper 404 status on unknown SPA paths.
  //
  // Before this, every unknown URL (e.g. `/foo-bar-xyz`) returned HTTP 200
  // with index.html because the SPA fallback is a catch-all. React Router
  // then rendered NotFoundPage inside that 200 response — a "soft 404" that
  // crawlers index as a real page. Google Search Console flagged this as
  // duplicate content and indexed the not-found page as its own URL.
  //
  // Fix: maintain a mirror of the React Router table in apps/web/src/main.tsx.
  // When the SPA fallback runs for a pathname that doesn't match any known
  // exact path or dynamic pattern, return HTTP 404 with the same SPA
  // index.html body (so the client-side router still renders NotFoundPage
  // without a double-render flash). Crawlers see the 404 status and don't
  // index the page; humans see the same NotFoundPage UX they did before.
  const knownExactPaths = new Set<string>([
    '/',
    '/index.html',
    '/apps',
    '/store',
    '/about',
    '/pricing',
    '/protocol',
    '/install',
    '/install-in-claude',
    '/docs',
    '/login',
    '/signup',
    '/forgot-password',
    '/reset-password',
    '/me',
    '/me/install',
    '/me/runs',
    '/me/settings',
    '/me/api-keys',
    '/me/settings/tokens',
    '/me/apps',
    '/me/secrets',
    '/studio',
    '/studio/build',
    '/studio/new',
    '/studio/settings',
    '/build',
    '/creator',
    '/browse',
    '/deploy',
    '/self-host',
    '/onboarding',
    '/changelog',
    '/waitlist',
    '/legal',
    '/legal/imprint',
    '/legal/privacy',
    '/legal/terms',
    '/legal/cookies',
    '/imprint',
    '/impressum',
    '/privacy',
    '/terms',
    '/cookies',
    '/spec',
    '/_creator-legacy',
    '/_build-legacy',
    '/404',
    '/404.html',
  ]);
  // Dynamic route patterns. Each matches a family of real routes declared
  // in apps/web/src/main.tsx. Keep slug shape permissive (`[a-z0-9-_]+`)
  // to match server-side slug validation in the rest of the codebase; a
  // nonsense slug still resolves to a real SPA route (and NotFoundPage if
  // the slug doesn't exist in the DB).
  const SLUG = '[a-z0-9][a-z0-9-]*';
  const RUN_ID = '[A-Za-z0-9_-]+';
  const knownDynamicPatterns: RegExp[] = [
    new RegExp(`^/p/${SLUG}/?$`),
    new RegExp(`^/p/${SLUG}/dashboard/?$`),
    new RegExp(`^/r/${RUN_ID}/?$`),
    new RegExp(`^/apps/${SLUG}/?$`),
    new RegExp(`^/store/${SLUG}/?$`),
    new RegExp(`^/install/${SLUG}/?$`),
    new RegExp(`^/docs/${SLUG}/?$`),
    new RegExp(`^/me/runs/${RUN_ID}/?$`),
    new RegExp(`^/me/apps/${SLUG}/?$`),
    new RegExp(`^/me/apps/${SLUG}/(secrets|run)/?$`),
    new RegExp(`^/me/a/${SLUG}/?$`),
    new RegExp(`^/me/a/${SLUG}/(secrets|run)/?$`),
    new RegExp(`^/studio/${SLUG}/?$`),
    new RegExp(
      `^/studio/${SLUG}/(runs|secrets|access|renderer|analytics|triggers)/?$`,
    ),
    new RegExp(`^/creator/${SLUG}/?$`),
    new RegExp(`^/_creator-legacy/${SLUG}/?$`),
    new RegExp(`^/spec(/.*)?$`),
    new RegExp(`^/protocol(/.*|#.*)?$`),
    new RegExp(`^/docs/.*$`), // docs catch-all ends at /docs landing via redirect
  ];
  function isKnownRoute(pathname: string): boolean {
    if (knownExactPaths.has(pathname)) return true;
    // Normalise trailing slash so "/apps/" matches "/apps"
    const stripped = pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;
    if (knownExactPaths.has(stripped)) return true;
    return knownDynamicPatterns.some((rx) => rx.test(pathname));
  }

  // Crawlers don't run JS, so client-side meta updates in AppPermalinkPage
  // never reach them. For /p/:slug we rewrite the og:image, og:title,
  // og:description (+ twitter equivalents) in the served HTML so previewers
  // see the per-app card.
  const pSlugPattern = /^\/p\/([a-z0-9][a-z0-9-]*)\/?$/;
  const publicOrigin = process.env.PUBLIC_ORIGIN || PUBLIC_URL || '';
  // 2026-04-22 (PR #400 ripple): consolidate on /og-main.png as the single
  // source of truth. Earlier, SSR pointed at /og-image.png and index.html
  // pointed at /og-main.png, so the served asset depended on whether SSR
  // ran. Unify everything on /og-main.png and delete the dup PNGs.
  const defaultOgImage = `${publicOrigin}/og-main.png`;

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
    // PR #404 ripple (2026-04-22): SSR titles for the new Install surface.
    // /install-in-claude is the generic 4-tab flow; /install/:slug wraps it
    // for a specific app. Both previously 404'd in the SPA; now they're
    // real routes and need their own crawl titles.
    if (pathname === '/install-in-claude' || pathname === '/install-in-claude/') {
      return 'Install in Claude · Floom';
    }
    if (pathname.startsWith('/install/')) return 'Install · Floom';
    // 2026-04-20 (about-page ship): /about is a real story page now (not
    // a redirect to landing). Per-route SSR title so crawlers + social
    // previews see the About title, not the landing title.
    // Audit 2026-04-24 (S2) follow-up to #512: SSR title was still leaking
    // the old marketing tagline into browser tabs (the client-side PageHead
    // fix in #512 only covered SPA navs, not first-load SSR). Matched to
    // `About · Floom` from AboutPage.tsx.
    if (pathname === '/about' || pathname === '/about/') {
      return 'About · Floom';
    }
    // 2026-04-20 (pricing-page ship): /pricing graduated from redirect
    // to a real page. Honest placeholder (free during beta, self-host
    // free forever, paid plans TBD). SSR title so outbound-comparison
    // crawlers see "Pricing", not the landing title.
    if (pathname === '/pricing' || pathname === '/pricing/') return 'Pricing · Floom';
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
    if (pathname === '/legal') return 'Legal · Floom';
    if (pathname === '/imprint') return 'Imprint · Floom';
    if (pathname === '/privacy') return 'Privacy · Floom';
    if (pathname === '/terms') return 'Terms · Floom';
    if (pathname === '/cookies') return 'Cookies · Floom';
    return null;
  }

  // Map a non-slug pathname to its OG/Twitter description + short social
  // title. Added 2026-04-22 for launch SEO pass — before this, every
  // non-slug page (Store, Pricing, About, Protocol, etc.) shared the
  // landing OG description, so every social preview looked identical.
  // Returns null for paths we haven't claimed (falls back to landing copy).
  type SocialMeta = { ogTitle: string; description: string };
  function socialMetaForPath(pathname: string): SocialMeta | null {
    if (pathname === '/apps' || pathname === '/apps/' || pathname === '/store' || pathname === '/store/') {
      return {
        ogTitle: 'Apps · Floom',
        description:
          'Browse AI apps built on Floom. Run them in your browser, install them into Claude, or fork and publish your own.',
      };
    }
    if (pathname === '/about' || pathname === '/about/') {
      return {
        ogTitle: 'About Floom',
        description:
          'Floom turns the thing you built on localhost into a real app with a real URL so other people can actually use it.',
      };
    }
    if (pathname === '/pricing' || pathname === '/pricing/') {
      return {
        ogTitle: 'Pricing · Floom',
        description:
          'Free during beta. Self-host free forever. Paid cloud plans coming soon.',
      };
    }
    if (pathname === '/install' || pathname === '/install/') {
      return {
        ogTitle: 'Install the Floom CLI',
        description:
          'One command to install the Floom CLI. Publish apps, run them locally, and link them to Claude in seconds.',
      };
    }
    // PR #404 ripple (2026-04-22): Install-in-Claude surface. The /install/:slug
    // variant wraps a specific app; we don't know the slug name here without a
    // DB hit, so a shared description works fine for preview cards. Per-slug
    // social metadata still flows through the /p/:slug permalink path which
    // crawlers hit from Apps listings.
    if (pathname === '/install-in-claude' || pathname === '/install-in-claude/') {
      return {
        ogTitle: 'Install in Claude · Floom',
        description:
          'Add Floom to Claude Desktop, Claude Code, Cursor, or any MCP client. Four steps, copy-paste snippets, MCP-native.',
      };
    }
    if (pathname.startsWith('/install/')) {
      return {
        ogTitle: 'Install this app in Claude · Floom',
        description:
          'One-click install for Claude Desktop, Claude Code, Cursor, and other MCP clients. Copy the snippet, drop it in your config, done.',
      };
    }
    if (pathname === '/protocol' || pathname.startsWith('/protocol/') || pathname.startsWith('/protocol#')) {
      return {
        ogTitle: 'The Floom Protocol',
        description:
          'The open protocol + runtime for agentic work. Vibe-coding speed. Production-grade safety. Read the spec.',
      };
    }
    if (pathname === '/login') {
      return {
        ogTitle: 'Sign in · Floom',
        description: 'Sign in to Floom to publish, run, and manage your AI apps.',
      };
    }
    if (pathname === '/signup') {
      return {
        ogTitle: 'Create account · Floom',
        description: 'Create a free Floom account to publish and run AI apps.',
      };
    }
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

    // Per-route og:url so crawlers don't see every page claiming it is "/".
    if (publicOrigin) {
      out = out.replace(
        /<meta property="og:url" content="[^"]*"/,
        `<meta property="og:url" content="${publicOrigin}${pathname === '/index.html' ? '/' : pathname}"`,
      );
    }

    // Per-route og:title + og:description + twitter equivalents. Before
    // 2026-04-22 every non-slug page inherited the landing OG block, so
    // every social preview read "Ship AI apps fast" regardless of page.
    const social = socialMetaForPath(pathname);
    if (social) {
      const t = social.ogTitle.replace(/"/g, '&quot;');
      const d = social.description.replace(/"/g, '&quot;').slice(0, 300);
      out = out.replace(
        /<meta property="og:title" content="[^"]*"/,
        `<meta property="og:title" content="${t}"`,
      );
      out = out.replace(
        /<meta property="og:description" content="[^"]*"/,
        `<meta property="og:description" content="${d}"`,
      );
      out = out.replace(
        /<meta name="twitter:title" content="[^"]*"/,
        `<meta name="twitter:title" content="${t}"`,
      );
      out = out.replace(
        /<meta name="twitter:description" content="[^"]*"/,
        `<meta name="twitter:description" content="${d}"`,
      );
      // Also rewrite <meta name="description"> so SERP snippets match.
      out = out.replace(
        /<meta name="description" content="[^"]*"/,
        `<meta name="description" content="${d}"`,
      );
    }

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
        `<div style="display:none" data-spa-fallback>\n        <h1>${aboutH1}</h1>\n        <p>${aboutSub}</p>\n        <p><a href="/studio/build">Paste your app</a> &middot; <a href="/">Home</a></p>\n      </div>`,
      );
      out = out.replace(
        /<noscript>[\s\S]*?<\/noscript>/,
        `<noscript>\n      <h1>${aboutH1}</h1>\n      <p>${aboutSub}</p>\n      <p><a href="/studio/build">Paste your app</a> &middot; <a href="/">Home</a></p>\n    </noscript>`,
      );
    }
    return out;
  }

  function rewriteHeadForSlug(html: string, slug: string): string {
    // Manual publish-review gate (#362): only surface name/description in
    // SSR meta tags for 'published' apps. Non-published apps (pending,
    // rejected, draft) render as a generic "App · Floom" to strangers so
    // the slug's name doesn't leak to crawlers/preview bots before a
    // human has reviewed it. The SPA + /api/hub/:slug gating still lets
    // the owner reach their own pending app.
    const row = db
      .prepare('SELECT name, description, publish_status, visibility FROM apps WHERE slug = ?')
      .get(slug) as
      | {
          name: string | null;
          description: string | null;
          publish_status: string | null;
          visibility: string | null;
        }
      | undefined;
    const isPubliclyListable =
      row &&
      isPublicListingVisibility(row.visibility) &&
      (row.visibility === 'public_live' || row.publish_status === 'published');
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
    if (row?.name && isPubliclyListable) {
      // 2026-04-20 (P2 #149): also rewrite the document <title> so
      // non-JS crawlers see `{app_name} · Floom` for /p/:slug.
      const documentTitle = `${row.name} · Floom`;
      out = rewriteTitle(out, documentTitle);
      // Audit 2026-04-24 (S2) follow-up to #512: normalized social-card
      // title separator to `·` so OG/Twitter previews match the document
      // title. Previously this shipped as `{name} | Floom` while the
      // rest of the site used `·`, causing inconsistent share previews.
      const title = `${row.name} · Floom`;
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
    if (row?.description && isPubliclyListable) {
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

  // CSP-safe deploy flag bootstrap: external same-origin script so the
  // top-level `script-src 'self'` policy still allows the flag setup.
  app.get('/__floom/bootstrap.js', () => {
    const body =
      'window.__FLOOM__=window.__FLOOM__||{};' +
      `window.__FLOOM__.deployEnabled=${isDeployEnabled()};`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-cache, no-store',
      },
    });
  });

  app.use('/*', async (c, next) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    const servedIndexHtml = getIndexHtmlForDeployFlag(true);

    // Skip API + MCP routes and named utility endpoints — let Hono handle them.
    if (
      spaExcludedPrefixes.some((p) => pathname.startsWith(p)) ||
      spaExcludedExact.has(pathname)
    ) {
      return next();
    }

    if (pathname === '/' || pathname === '/index.html') {
      return new Response(rewriteHeadForLanding(servedIndexHtml), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        },
      });
    }

    // 2026-04-24 (SEO #348): /apps/<slug> and /store/<slug> are legacy
    // patterns that funnel into /p/<slug> client-side. On the server we
    // return a real 301 so crawlers don't index both URLs and users who
    // follow old backlinks from tweets/LinkedIn land on the canonical
    // permalink without a flash of 404 copy. Listing paths (exact /apps
    // and /store) stay on the directory page — only deep slug paths
    // redirect.
    const legacyAppsMatch = pathname.match(/^\/(?:apps|store)\/([a-z0-9][a-z0-9-]*)\/?$/);
    if (legacyAppsMatch && legacyAppsMatch[1]) {
      const target = `/p/${legacyAppsMatch[1]}`;
      return new Response(null, {
        status: 301,
        headers: { location: target, 'cache-control': 'public, max-age=3600' },
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
            : ext === 'jpg' || ext === 'jpeg'
            ? 'image/jpeg'
            : ext === 'gif'
            ? 'image/gif'
            : ext === 'avif'
            ? 'image/avif'
            : ext === 'ico'
            ? 'image/x-icon'
            : ext === 'woff'
            ? 'font/woff'
            : ext === 'woff2'
            ? 'font/woff2'
            : ext === 'xml'
            ? 'application/xml; charset=utf-8'
            : ext === 'txt'
            ? 'text/plain; charset=utf-8'
            : ext === 'sh'
            ? 'text/plain; charset=utf-8'
            : ext === 'md'
            ? 'text/markdown; charset=utf-8'
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
      const appRow = db
        .prepare(
          'SELECT id, slug, author, workspace_id, visibility, link_share_token, link_share_requires_auth FROM apps WHERE slug = ?',
        )
        .get(slugMatch[1]) as
        | {
            id: string;
            slug: string;
            author: string | null;
            workspace_id: string;
            visibility: string | null;
            link_share_token: string | null;
            link_share_requires_auth: number;
          }
        | undefined;
      if (!appRow) {
        return c.html(rewriteTitle(servedIndexHtml, 'App not found · Floom'), 404);
      }
      const ctx = await resolveUserContext(c);
      const access = getAppAccessDecision(appRow, ctx, url.searchParams.get('key'));
      if (!access.ok) {
        if (access.status === 401) {
          return c.html(rewriteTitle(servedIndexHtml, 'Authentication required · Floom'), 401);
        }
        return c.html(rewriteTitle(servedIndexHtml, 'App not found · Floom'), 404);
      }
      return c.html(rewriteHeadForSlug(servedIndexHtml, slugMatch[1]));
    }
    // 2026-04-20 (PRR tail cleanup): explicit /404 path returns 404 status.
    if (pathname === '/404' || pathname === '/404.html') {
      return new Response(
        rewriteTitle(rewriteCanonical(servedIndexHtml, pathname), 'Page not found · Floom'),
        {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
        },
      );
    }
    // SEO #621: soft-404 fix. If the path isn't in the known-route table
    // (mirror of apps/web/src/main.tsx), return the SPA index.html with
    // HTTP 404 so crawlers see a real 404 and don't index the page. React
    // Router's wildcard still renders NotFoundPage client-side inside the
    // 404 response body, so the UX is unchanged. Known routes (including
    // dynamic patterns like /p/:slug) continue to return 200.
    if (!isKnownRoute(pathname)) {
      return new Response(
        rewriteTitle(rewriteCanonical(servedIndexHtml, pathname), 'Page not found · Floom'),
        {
          status: 404,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
          },
        },
      );
    }
    return c.html(rewriteHeadForPath(servedIndexHtml, pathname));
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
      const purgedSessions = purgeUnverifiedAuthSessions();
      if (purgedSessions > 0) {
        console.log(`[auth] purged ${purgedSessions} unverified auth session(s)`);
      }
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

  // Launch-demo seeder (#252): builds + registers the 3 showcase apps
  // (lead-scorer, competitor-analyzer, resume-screener) from
  // examples/<slug>/ on boot. Idempotent — skips build if the image tag
  // already exists, skips insert if the slug row already exists.
  try {
    await seedLaunchDemos();
  } catch (err) {
    console.error('[launch-demos] failed:', err);
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

  // Zombie-run recovery (#349). The run worker is fire-and-forget, so any
  // run left in `status='running'` when this process starts is orphaned —
  // the old worker died with it. Flip them to `error` so the client
  // taxonomy renders a real card and /api/runs/<id> stops polling forever.
  // Then spin up the periodic sweeper so in-flight runs that stall past
  // the absolute timeout ceiling also get reaped.
  try {
    const swept = sweepZombieRuns();
    if (swept > 0) {
      console.log(`[runner] boot sweeper reaped ${swept} zombie run${swept === 1 ? '' : 's'}`);
    }
  } catch (err) {
    console.warn(`[runner] boot sweeper failed: ${(err as Error).message}`);
  }
  if (process.env.FLOOM_DISABLE_ZOMBIE_SWEEPER !== 'true') {
    startZombieRunSweeper();
  }

  // ADR-011 run retention. Default behavior remains indefinite because the
  // sweeper only deletes rows for apps with max_run_retention_days set.
  if (process.env.FLOOM_DISABLE_RETENTION_SWEEPER !== 'true') {
    startRunRetentionSweeper();
  }

  // Start the triggers scheduler. Polls the `triggers` table every 30s
  // and enqueues jobs for schedule-type triggers whose next_run_at has
  // arrived. Opt-out via FLOOM_DISABLE_TRIGGERS_WORKER=true for tests.
  if (process.env.FLOOM_DISABLE_TRIGGERS_WORKER !== 'true') {
    startTriggersWorker();
  }

  if (process.env.FLOOM_DISABLE_ACCOUNT_DELETE_SWEEPER !== 'true') {
    startAccountDeleteSweeper();
  }

  if (process.env.FLOOM_DISABLE_AUDIT_SWEEPER !== 'true') {
    startAuditLogRetentionSweeper();
  }

  // ADR-015 GitHub deploys: resume any in-flight public-repo builds after
  // process restarts. New builds are also enqueued directly by the route.
  startGithubBuildWorker();

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
