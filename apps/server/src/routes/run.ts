// POST /api/run — start a run on an app.
// Also handles POST /api/:slug/run — the slug-based endpoint for self-hosted use.
// Returns { run_id } immediately. The client opens /api/run/:id/stream as SSE
// to receive stdout lines live, and GET /api/run/:id for the final status.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } from '../db.js';
import { newRunId } from '../lib/ids.js';
import { dispatchRun, getRun } from '../services/runner.js';
import { validateInputs, ManifestError } from '../services/manifest.js';
import { getOrCreateStream } from '../lib/log-stream.js';
import { storage } from '../services/storage.js';
import { checkAppVisibility, hasValidAdminBearer } from '../lib/auth.js';
import { isCloudMode } from '../lib/better-auth.js';
import { resolveUserContext } from '../services/session.js';
import { parseJsonBody, bodyParseError } from '../lib/body.js';
import { extractIp } from '../lib/rate-limit.js';
import {
  byokRequiredResponse,
  decideByok,
  hashUserAgent,
  isByokGated,
  recordFreeRun,
} from '../lib/byok-gate.js';
import type {
  NormalizedManifest,
  RunRecord,
  SessionContext,
} from '../types.js';
import type { RunListFilter } from '../adapters/types.js';

/**
 * BYOK header: callers can pass their own Gemini API key on a per-run basis.
 * When present AND the app is in BYOK_GATED_SLUGS, the server:
 *   1. Does NOT count the run against the 5/day free budget.
 *   2. Injects the key as a per-call secret (GEMINI_API_KEY).
 *   3. Never logs or persists the value (it's merged into mergedSecrets for
 *      this single dispatchRun call only).
 *
 * Header name kept lowercase on read (Hono normalizes) and well-known so
 * the frontend and any curl-user can discover it in the 429 payload docs.
 */
const USER_API_KEY_HEADER = 'x-user-api-key';

function extractUserApiKey(c: Context): string | null {
  const raw = c.req.header(USER_API_KEY_HEADER);
  if (!raw) return null;
  const trimmed = raw.trim();
  // Minimum plausible length for a Google AI Studio key (prefix "AIza" +
  // 35 chars). We don't hard-validate here — the dry-run path inside the
  // container is the real authority on whether the key works — but a
  // blank/near-blank header should fall through to free-quota instead of
  // being treated as "user provided a key".
  if (trimmed.length < 20) return null;
  return trimmed;
}

export const runRouter = new Hono();

type RunAppAccessRow = {
  slug: string;
  visibility: string | null;
  author: string | null;
};

async function loadAuthorizedRunApp(
  c: Context,
  appId: string,
): Promise<{ app: RunAppAccessRow | undefined; blocked: Response | null }> {
  const app = storage.getAppById(appId);
  if (!app) return { app: undefined, blocked: null };
  const runAccessRow: RunAppAccessRow = { slug: app.slug, visibility: app.visibility, author: app.author };
  const ctx = await resolveUserContext(c);
  const blocked = checkAppVisibility(c, app.visibility || 'public', {
    author: app.author,
    ctx,
  });
  return { app: runAccessRow, blocked };
}

/**
 * Ownership check for a GET on a specific run.
 *
 * Security contract (P0 2026-04-20):
 *   - The run is always scoped by workspace_id.
 *   - In cloud mode (is_authenticated=true), the caller must match
 *     `runs.user_id`. Device id is never sufficient for an authed caller
 *     because device cookies can trivially be copied between browsers.
 *   - In OSS / anonymous mode, the caller must match `runs.device_id` and
 *     the run must not carry a non-default `user_id` (i.e. someone else
 *     authenticated and claimed it). This keeps the self-host single-user
 *     box working while preventing cookie theft from leaking a logged-in
 *     user's run back to an anonymous session.
 *
 * Returns `'owner'` when the caller owns the run, `'public'` when the run
 * has been explicitly shared via POST /api/run/:id/share (caller gets a
 * redacted view, outputs only), and `'deny'` for everyone else. The
 * caller must treat `'deny'` as a 404 (not 403) so that probing run ids
 * can't distinguish "this run doesn't exist" from "this run exists but
 * you can't see it".
 */
function checkRunAccess(
  ctx: SessionContext,
  run: Pick<RunRecord, 'workspace_id' | 'user_id' | 'device_id' | 'is_public'>,
): 'owner' | 'public' | 'deny' {
  // Defensive: older rows predating the W2.1 migration may lack workspace_id.
  // Treat missing as the synthetic default — they always belonged to the
  // local workspace.
  const runWorkspace = run.workspace_id || DEFAULT_WORKSPACE_ID;

  // OSS single-user box back-compat: when Floom boots without
  // FLOOM_CLOUD_MODE the whole environment is one user. `fetch`-based
  // clients (curl, CI scripts, node tests) don't carry the device cookie
  // across calls, so enforcing device_id parity would 404 every legit
  // poll on the self-host flow. Unauthenticated reads on the synthetic
  // 'local' workspace are allowed; Cloud deployments never hit this
  // branch because isCloudMode() is true.
  if (!isCloudMode() && runWorkspace === DEFAULT_WORKSPACE_ID) {
    return 'owner';
  }

  // Owner match path. In cloud mode we require authenticated user_id
  // equality; in OSS / anon we require device_id equality and a run that
  // hasn't been claimed by a logged-in user. Both branches also require
  // workspace_id parity so cross-workspace leaks are impossible in a
  // multi-tenant Cloud deployment.
  if (ctx.is_authenticated) {
    if (
      runWorkspace === ctx.workspace_id &&
      run.user_id &&
      run.user_id === ctx.user_id
    ) {
      return 'owner';
    }
  } else {
    const runUser = run.user_id || null;
    const isUnclaimed = runUser === null || runUser === DEFAULT_USER_ID;
    if (
      runWorkspace === ctx.workspace_id &&
      isUnclaimed &&
      run.device_id &&
      run.device_id === ctx.device_id
    ) {
      return 'owner';
    }
  }

  if (run.is_public === 1) return 'public';
  return 'deny';
}

/**
 * Redacted public-view payload for a run the creator explicitly shared.
 * Strips inputs (may carry API keys or user PII), logs (may echo
 * validation traces that reference inputs), and upstream_status (not
 * useful to a public viewer, and removing it keeps the diagnostic surface
 * owner-only). Consumers see just enough to render the output surface.
 */
function formatPublicShareView(
  run: RunRecord,
  appSlug: string | null,
): Record<string, unknown> {
  return {
    id: run.id,
    app_id: run.app_id,
    app_slug: appSlug,
    action: run.action,
    status: run.status,
    outputs: safeParse(run.outputs),
    duration_ms: run.duration_ms,
    started_at: run.started_at,
    finished_at: run.finished_at,
    is_public: true,
    // Explicit nulls so the client can distinguish "redacted" from
    // "missing field" without guessing from shape.
    inputs: null,
    logs: null,
    error: null,
    error_type: null,
    upstream_status: null,
    thread_id: null,
  };
}

runRouter.post('/', async (c) => {
  // 2026-04-20 (P2 #146): malformed JSON used to fall through to
  // `catch(() => ({}))` and silently become an empty body — which, for actions
  // with no required inputs, resulted in a 200 + run_id on junk input.
  // parseJsonBody distinguishes "no body" (OK, treat as {}) from "truncated
  // or otherwise invalid JSON" (error, must 400). We keep the empty-body
  // fallback for ergonomic `curl -X POST` calls on zero-input actions.
  const parsed = await parseJsonBody(c);
  if (parsed.kind === 'error') return bodyParseError(c, parsed);
  const body = parsed.value as {
    app_slug?: unknown;
    inputs?: unknown;
    action?: unknown;
    thread_id?: unknown;
  };
  if (typeof body.app_slug !== 'string') {
    return c.json({ error: '"app_slug" is required' }, 400);
  }
  const row = storage.getApp(body.app_slug as string);
  if (!row) return c.json({ error: `App not found: ${body.app_slug}` }, 404);
  if (row.status !== 'active') {
    return c.json({ error: `App is ${row.status}, cannot run` }, 409);
  }
  const ctx = await resolveUserContext(c);
  const blocked = checkAppVisibility(c, row.visibility || 'public', {
    author: row.author,
    ctx,
  });
  if (blocked) return blocked;

  let manifest: NormalizedManifest;
  try {
    manifest = JSON.parse(row.manifest) as NormalizedManifest;
  } catch {
    return c.json({ error: 'App manifest is corrupted' }, 500);
  }

  const actionNames = Object.keys(manifest.actions);
  const actionName =
    (typeof body.action === 'string' && body.action) ||
    (manifest.actions.run ? 'run' : actionNames[0]);
  const actionSpec = manifest.actions[actionName];
  if (!actionSpec) {
    return c.json({ error: `Action "${actionName}" not found` }, 400);
  }

  let validated: Record<string, unknown>;
  try {
    validated = validateInputs(
      actionSpec,
      (body.inputs as Record<string, unknown>) ?? {},
    );
  } catch (err) {
    const e = err as ManifestError;
    return c.json({ error: e.message, field: e.field }, 400);
  }

  // Launch-week BYOK gate (2026-04-21).
  // Scoped to the 3 hero demo apps (lead-scorer / competitor-analyzer /
  // resume-screener). First 5 anon runs per IP per 24h are Floom-paid; after
  // that the caller must provide X-User-Api-Key (their own Gemini key).
  // Admin bearers bypass (internal ops / monitoring). Everyone else is
  // treated the same for launch — cloud auth'd callers share the same budget
  // as anon. We can split later if abuse materializes.
  const bypassBecauseAdmin = hasValidAdminBearer(c);
  const userApiKey = extractUserApiKey(c);
  const perCallSecrets: Record<string, string> = {};
  if (isByokGated(row.slug) && !bypassBecauseAdmin) {
    const ip = extractIp(c);
    // Defense-in-depth against pure-IP bypass (CSO P1-2, 2026-04-23): the
    // (ip + UA-hash) combo makes two browsers behind the same NAT get
    // separate budgets, and the subnet-burst detector inside decideByok
    // tightens the limit to 1 free run for a /24 under attack. Not a
    // silver bullet; a headless bot rotating both IP AND UA from a proxy
    // pool can still exhaust, but this raises the cost meaningfully.
    const uaHash = hashUserAgent(c.req.header('user-agent'));
    const decision = decideByok(ip, row.slug, userApiKey !== null, undefined, uaHash);
    if (decision.block) {
      return c.json(
        byokRequiredResponse(row.slug, decision.usage, decision.limit),
        429,
      );
    }
    if (userApiKey) {
      // BYOK path: inject the caller's key for this run only. perCallSecrets
      // is transient — dispatchRun merges it into the per-run secrets bag
      // and never writes it to disk. Do NOT record against the free budget;
      // the user is paying their own API bill.
      perCallSecrets.GEMINI_API_KEY = userApiKey;
    } else {
      // Free path: count this run against the 24h budget BEFORE dispatch so
      // a burst of 6 concurrent requests can't all slip through the
      // usage<5 check.
      recordFreeRun(ip, row.slug, undefined, uaHash);
      if (decision.tightened) {
        // eslint-disable-next-line no-console
        console.warn(
          `[byok-gate] subnet burst tightened limit ip=${ip} slug=${row.slug}`,
        );
      }
    }
  }

  // W4M.1: scope the run by the current session so /api/me/runs can filter
  // by user_id / device_id. `ctx` was already resolved above for the
  // visibility check (private apps need the caller's user_id).
  const runId = newRunId();
  const threadId = typeof body.thread_id === 'string' ? body.thread_id : null;
  storage.createRun({
    id: runId,
    app_id: row.id,
    thread_id: threadId,
    action: actionName,
    inputs: validated,
    workspace_id: ctx.workspace_id,
    user_id: ctx.user_id,
    device_id: ctx.device_id,
  });

  // W4-minimal gap close: pass the resolved session context so the runner
  // can look up per-user secrets (user_secrets table). Without this, the
  // runner falls back to the synthetic 'local' workspace and every
  // authenticated user's /api/secrets POST is effectively invisible to
  // their own runs.
  //
  // BYOK key (if any) rides in as perCallSecrets — highest-precedence slot
  // in dispatchRun's merge order. Transient, never persisted.
  dispatchRun(
    row,
    manifest,
    runId,
    actionName,
    validated,
    Object.keys(perCallSecrets).length > 0 ? perCallSecrets : undefined,
    ctx,
  );

  return c.json({ run_id: runId, status: 'pending' });
});

// GET /api/run/:id — latest snapshot.
//
// Security (P0 2026-04-20, run-auth lockdown):
//   - Default: owner-only. Runs are scoped by (workspace_id, user_id) for
//     authenticated callers and (workspace_id, device_id) for anonymous
//     ones. Non-owners get 404 (not 403) so run-id probing can't
//     distinguish "doesn't exist" from "you can't see it".
//   - Opt-in public share: when the owner hits POST /api/run/:id/share,
//     `runs.is_public` flips to 1. Anonymous callers then see a redacted
//     view (outputs only — inputs/logs/upstream_status stripped).
//   - The app-level auth-required / private visibility gate still runs
//     on top of the ownership check, so an auth-required app's runs stay
//     bearer-token-gated even when marked public.
runRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = getRun(id);
  if (!row) return c.json({ error: 'Run not found' }, 404);

  const { app, blocked } = await loadAuthorizedRunApp(c, row.app_id);
  if (blocked) return blocked;

  // Server-admin escape hatch: when FLOOM_AUTH_TOKEN is configured and the
  // caller presents it, they bypass the ownership gate and see the full
  // payload. This preserves the self-host operator flow (same as the one
  // on auth-required apps). Without an explicitly-set token this branch
  // is a no-op, so OSS mode without FLOOM_AUTH_TOKEN still enforces
  // per-device ownership.
  if (hasValidAdminBearer(c)) {
    return c.json({ ...formatRun(row), app_slug: app?.slug ?? null });
  }

  const ctx = await resolveUserContext(c);
  const access = checkRunAccess(ctx, row);
  if (access === 'owner') {
    return c.json({ ...formatRun(row), app_slug: app?.slug ?? null });
  }
  if (access === 'public') {
    return c.json(formatPublicShareView(row, app?.slug ?? null));
  }
  return c.json({ error: 'Run not found' }, 404);
});

// GET /api/run/:id/stream — SSE stream of stdout + status transitions.
// Same ownership contract as GET /api/run/:id. Public-shared runs do NOT
// open the stream — live logs can leak partial inputs and the share
// intent is strictly "see the final output".
runRouter.get('/:id/stream', async (c) => {
  const id = c.req.param('id');
  const row = getRun(id);
  if (!row) return c.json({ error: 'Run not found' }, 404);
  const { blocked } = await loadAuthorizedRunApp(c, row.app_id);
  if (blocked) return blocked;

  // Same admin-bearer bypass as GET /api/run/:id. See the rationale there.
  const ctx = await resolveUserContext(c);
  if (!hasValidAdminBearer(c)) {
    const access = checkRunAccess(ctx, row);
    if (access !== 'owner') {
      return c.json({ error: 'Run not found' }, 404);
    }
  }

  return streamSSE(c, async (stream) => {
    const logStream = getOrCreateStream(id);
    let done = false;

    const send = async (event: string, data: unknown) => {
      await stream.writeSSE({
        event,
        data: JSON.stringify(data),
      });
    };

    // Replay history + latest status up front.
    const handle = logStream.subscribe(
      async (line) => {
        if (done) return;
        try {
          await send('log', { stream: line.stream, text: line.text, ts: line.ts });
        } catch {
          // client disconnected
        }
      },
      async () => {
        if (done) return;
        const fresh = getRun(id);
        if (fresh) {
          try {
            await send('status', formatRun(fresh));
          } catch {
            // ignore
          }
        }
        done = true;
      },
    );

    // Send replay history
    for (const line of handle.history) {
      await send('log', { stream: line.stream, text: line.text, ts: line.ts });
    }

    // Initial status
    const fresh = getRun(id);
    if (fresh) await send('status', formatRun(fresh));

    // If already done before subscribe, emit final status and close.
    if (handle.done) {
      handle.unsubscribe();
      return;
    }

    // Wait up to 10 minutes for finish. Status polling is also wired so the
    // client can poll GET /api/run/:id separately.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        done = true;
        handle.unsubscribe();
        resolve();
      }, 10 * 60 * 1000);

      const origUnsub = handle.unsubscribe;
      handle.unsubscribe = () => {
        clearTimeout(timer);
        origUnsub();
        resolve();
      };

      // Closing via stream abort
      stream.onAbort(() => {
        done = true;
        clearTimeout(timer);
        origUnsub();
        resolve();
      });

      // If the stream is already done when we got here, finish immediately.
      if (done) {
        clearTimeout(timer);
        origUnsub();
        resolve();
      }
    });
  });
});

// POST /api/run/:id/share — flip `runs.is_public` to 1. Owner-only; returns
// 404 to everyone else to keep run-ids unguessable. Idempotent: re-sharing
// an already-public run is a no-op and returns the same URLs.
//
// Response shape:
//   { share_url: string, public_view_url: string, is_public: true }
// where `share_url` is the web /r/:id permalink (what humans paste in a
// DM) and `public_view_url` is the redacted JSON GET that the permalink
// page hydrates from.
runRouter.post('/:id/share', async (c) => {
  const id = c.req.param('id');
  const row = getRun(id);
  if (!row) return c.json({ error: 'Run not found' }, 404);

  // App-level visibility still applies. Private apps never get a public
  // share link — the run's outputs might cite private-app metadata, and
  // the whole point of `private` is that the app is owner-only too.
  const { app, blocked } = await loadAuthorizedRunApp(c, row.app_id);
  if (blocked) return blocked;

  // Admin-bearer bypass mirrors GET; otherwise require ownership.
  if (!hasValidAdminBearer(c)) {
    const ctx = await resolveUserContext(c);
    const access = checkRunAccess(ctx, row);
    if (access !== 'owner') {
      return c.json({ error: 'Run not found' }, 404);
    }
  }

  // Idempotent flip. SQLite returns changes=0 on a no-op UPDATE which is fine.
  storage.updateRun(id, { is_public: 1 } as any); // using any for now since is_public is not in patch shape

  const publicUrl = `/api/run/${encodeURIComponent(id)}`;
  const shareUrl = `/r/${encodeURIComponent(id)}`;
  return c.json({
    share_url: shareUrl,
    public_view_url: publicUrl,
    is_public: true,
    app_slug: app?.slug ?? null,
  });
});

function formatRun(row: {
  id: string;
  app_id: string;
  thread_id: string | null;
  action: string;
  inputs: string | null;
  outputs: string | null;
  logs: string;
  status: string;
  error: string | null;
  error_type: string | null;
  // Optional so older sqlite snapshots that predate the upstream_status
  // migration still satisfy the type — SELECT * will surface it as
  // undefined and we fall through to null below.
  upstream_status?: number | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    app_id: row.app_id,
    thread_id: row.thread_id,
    action: row.action,
    inputs: safeParse(row.inputs),
    outputs: safeParse(row.outputs),
    status: row.status,
    error: row.error,
    error_type: row.error_type,
    // Error taxonomy (2026-04-20): the HTTP status the upstream API
    // returned, when one was received. The /p/:slug runner surface uses
    // this to pick between user_input_error / auth_error /
    // upstream_outage without re-parsing the raw error string.
    upstream_status: row.upstream_status ?? null,
    duration_ms: row.duration_ms,
    started_at: row.started_at,
    finished_at: row.finished_at,
    logs: row.logs,
  };
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------- slug-based run router ----------
// POST /api/:slug/run — convenience endpoint for self-hosted instances.
// Accepts { action?, inputs? } body; slug is from the URL path.
export const slugRunRouter = new Hono<{ Variables: { slug: string } }>();

slugRunRouter.post('/', async (c) => {
  const slug = c.req.param('slug');
  if (!slug) return c.json({ error: 'Missing slug' }, 400);
  const row = storage.getApp(slug);
  if (!row) return c.json({ error: `App not found: ${slug}` }, 404);
  if (row.status !== 'active') {
    return c.json({ error: `App is ${row.status}, cannot run` }, 409);
  }
  const ctx = await resolveUserContext(c);
  const blocked = checkAppVisibility(c, row.visibility || 'public', {
    author: row.author,
    ctx,
  });
  if (blocked) return blocked;

  let manifest: NormalizedManifest;
  try {
    manifest = JSON.parse(row.manifest) as NormalizedManifest;
  } catch {
    return c.json({ error: 'App manifest is corrupted' }, 500);
  }

  // 2026-04-20 (P2 #146): reject malformed JSON at the edge instead of
  // silently coercing to {}. See the same rationale on POST /api/run above.
  const parsed = await parseJsonBody(c);
  if (parsed.kind === 'error') return bodyParseError(c, parsed);
  const body = parsed.value as {
    action?: unknown;
    inputs?: unknown;
  };

  const actionNames = Object.keys(manifest.actions);
  const actionName =
    (typeof body.action === 'string' && body.action) ||
    (manifest.actions.run ? 'run' : actionNames[0]);
  const actionSpec = manifest.actions[actionName];
  if (!actionSpec) {
    return c.json({ error: `Action "${actionName}" not found` }, 400);
  }

  let validated: Record<string, unknown>;
  try {
    validated = validateInputs(
      actionSpec,
      (body.inputs as Record<string, unknown>) ?? {},
    );
  } catch (err) {
    const e = err as ManifestError;
    return c.json({ error: e.message, field: e.field }, 400);
  }

  // Launch-week BYOK gate (2026-04-21). Mirrors POST /api/run above —
  // the slug-based endpoint is the same product surface (e.g. curl users,
  // self-host), so it shares the same 5-free-runs-then-BYOK rule for the
  // 3 hero demo apps.
  const bypassBecauseAdminSlug = hasValidAdminBearer(c);
  const userApiKeySlug = extractUserApiKey(c);
  const perCallSecretsSlug: Record<string, string> = {};
  if (isByokGated(row.slug) && !bypassBecauseAdminSlug) {
    const ip = extractIp(c);
    const uaHashSlug = hashUserAgent(c.req.header('user-agent'));
    const decision = decideByok(ip, row.slug, userApiKeySlug !== null, undefined, uaHashSlug);
    if (decision.block) {
      return c.json(
        byokRequiredResponse(row.slug, decision.usage, decision.limit),
        429,
      );
    }
    if (userApiKeySlug) {
      perCallSecretsSlug.GEMINI_API_KEY = userApiKeySlug;
    } else {
      recordFreeRun(ip, row.slug, undefined, uaHashSlug);
      if (decision.tightened) {
        // eslint-disable-next-line no-console
        console.warn(
          `[byok-gate] subnet burst tightened limit ip=${ip} slug=${row.slug}`,
        );
      }
    }
  }

  // W4M.1: scope the run by the current session. `ctx` already resolved
  // for the visibility check above.
  const runId = newRunId();
  storage.createRun({
    id: runId,
    app_id: row.id,
    thread_id: null,
    action: actionName,
    inputs: validated,
    workspace_id: ctx.workspace_id,
    user_id: ctx.user_id,
    device_id: ctx.device_id,
  });

  // W4-minimal gap close: pass the resolved session context so the runner
  // can look up per-user secrets (user_secrets table). Without this, the
  // runner falls back to the synthetic 'local' workspace and every
  // authenticated user's /api/secrets POST is effectively invisible to
  // their own runs.
  dispatchRun(
    row,
    manifest,
    runId,
    actionName,
    validated,
    Object.keys(perCallSecretsSlug).length > 0 ? perCallSecretsSlug : undefined,
    ctx,
  );

  return c.json({ run_id: runId, status: 'pending' });
});

// ---------- /api/:slug/quota : read-only peek at the BYOK free-run budget ----------
//
// Launch-week product need (2026-04-25): on `/p/:slug` we want to tell the
// user, BEFORE they click Run:
//
//   "Free runs · 3 of 5 today — Floom covers the first 5 today, then bring
//   your own Gemini key."
//
// The information already exists server-side in byok-gate.ts (peekUsage +
// decideByok read the in-memory sliding window), but the only way to learn
// your remaining quota was to hit POST /api/run and get a 429 back. That
// worked for the "user tries to run" case but gave us no way to render a
// live counter in the UI.
//
// This endpoint exposes the same numbers read-only. It NEVER records a run,
// so polling it is free. Response shape:
//
//   - Gated slug:     { gated: true, slug, usage, limit, remaining,
//                       window_ms, has_user_key_hint }
//   - Non-gated slug: { gated: false, slug }
//   - Unknown slug:   404 `{ error: 'App not found: <slug>' }`
//
// `has_user_key_hint` is a server-echo of whether the caller sent a
// non-empty X-User-Api-Key header. Purely informational for the UI — the
// authoritative "do I have a key saved" check lives in the browser
// (readUserGeminiKey), because the server never persists user keys.
//
// Security:
//   - No auth required: same public surface as POST /api/run for gated slugs.
//   - Does NOT record a sighting in the subnet-burst detector — we don't
//     want legitimate counter-polling to trip the abuse heuristic.
//   - Returns 200 even when the caller would be blocked by BYOK (remaining: 0).
//     Blocking happens on POST /api/run as today.
export const slugQuotaRouter = new Hono<{ Variables: { slug: string } }>();

slugQuotaRouter.get('/', async (c) => {
  // Hono's param typing on a generic router is `string | undefined`; a
  // request that somehow matched the route without a slug would be a
  // framework bug, but typing forces us to narrow so the downstream
  // helpers (isByokGated, decideByok) receive a guaranteed string.
  const slug = c.req.param('slug');
  if (!slug) return c.json({ error: 'slug is required' }, 400);
  const row = db.prepare('SELECT slug FROM apps WHERE slug = ?').get(slug) as
    | { slug: string }
    | undefined;
  if (!row) return c.json({ error: `App not found: ${slug}` }, 404);

  if (!isByokGated(slug)) {
    // Non-gated apps don't have a per-IP free budget; the UI should hide
    // the counter strip entirely. We still return 200 so the client can
    // call the endpoint on every app page without branching on status
    // codes — `gated === false` is the signal to hide the strip.
    return c.json({ gated: false, slug });
  }

  const ip = extractIp(c);
  const uaHash = hashUserAgent(c.req.header('user-agent'));
  const hasUserKey = extractUserApiKey(c) !== null;
  // decideByok is read-only; it does NOT push a sighting into the
  // subnet-burst detector. Safe to call from a counter-polling endpoint.
  const decision = decideByok(ip, slug, hasUserKey, undefined, uaHash);
  const remaining = Math.max(0, decision.limit - decision.usage);
  return c.json({
    gated: true,
    slug,
    usage: decision.usage,
    limit: decision.limit,
    remaining,
    window_ms: 24 * 60 * 60 * 1000,
    has_user_key_hint: hasUserKey,
  });
});

// ---------- /api/me/runs : per-user run history ----------
// Returns the caller's run history scoped by (workspace_id, user_id) in
// cloud mode and by (workspace_id, device_id) in OSS mode. Joins `apps`
// so the UI can render the app name + icon without a second fetch.
export const meRouter = new Hono();

type StudioAppSummaryRow = {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  publish_status: string | null;
  visibility: string | null;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  runs_7d: number;
};

function isStudioAppLive(publish_status: string | null): boolean {
  return !publish_status || publish_status === 'published';
}

function studioRunsDeltaPct(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function feedbackAppSlugFromUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = raw.startsWith('/')
      ? new URL(raw, 'http://localhost')
      : new URL(raw);
    const match = /^\/p\/([^/?#]+)/.exec(url.pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function loadStudioApps(
  ctx: SessionContext,
): StudioAppSummaryRow[] {
  const isOssLocal = !ctx.is_authenticated && ctx.workspace_id === DEFAULT_WORKSPACE_ID;
  if (isOssLocal) {
    return db.prepare(
      `SELECT apps.id, apps.slug, apps.name, apps.icon, apps.publish_status,
              apps.visibility, apps.created_at, apps.updated_at,
              (
                SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
              ) AS last_run_at,
              (
                SELECT COUNT(*) FROM runs
                 WHERE runs.app_id = apps.id
                   AND runs.started_at >= datetime('now', '-7 days')
              ) AS runs_7d
         FROM apps
        WHERE apps.workspace_id = ?
        ORDER BY
          CASE WHEN (
            SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
          ) IS NULL THEN 1 ELSE 0 END,
          (
            SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
          ) DESC,
          apps.updated_at DESC`
    ).all(ctx.workspace_id) as StudioAppSummaryRow[];
  }

  return db.prepare(
    `SELECT apps.id, apps.slug, apps.name, apps.icon, apps.publish_status,
            apps.visibility, apps.created_at, apps.updated_at,
            (
              SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
            ) AS last_run_at,
            (
              SELECT COUNT(*) FROM runs
               WHERE runs.app_id = apps.id
                 AND runs.started_at >= datetime('now', '-7 days')
            ) AS runs_7d
       FROM apps
      WHERE apps.workspace_id = ?
        AND apps.author = ?
      ORDER BY
        CASE WHEN (
          SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
        ) IS NULL THEN 1 ELSE 0 END,
        (
          SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
        ) DESC,
        apps.updated_at DESC`
  ).all(ctx.workspace_id, ctx.user_id) as StudioAppSummaryRow[];
}

meRouter.get('/studio/stats', async (c) => {
  const ctx = await resolveUserContext(c);
  const apps = loadStudioApps(ctx);
  const appIds = apps.map((app) => app.id);
  const appSlugs = new Set(apps.map((app) => app.slug));

  const membersRow = db
    .prepare('SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id = ?')
    .get(ctx.workspace_id) as { c: number } | undefined;
  const workspaceMemberCount = Number(membersRow?.c || 0);

  let runsCurrent = 0;
  let runsPrevious = 0;
  if (appIds.length > 0) {
    const placeholders = appIds.map(() => '?').join(', ');
    const currentRow = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM runs
          WHERE app_id IN (${placeholders})
            AND started_at >= datetime('now', '-7 days')`,
      )
      .get(...appIds) as { c: number } | undefined;
    runsCurrent = Number(currentRow?.c || 0);

    const previousRow = db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM runs
          WHERE app_id IN (${placeholders})
            AND started_at >= datetime('now', '-14 days')
            AND started_at < datetime('now', '-7 days')`,
      )
      .get(...appIds) as { c: number } | undefined;
    runsPrevious = Number(previousRow?.c || 0);
  }

  // Feedback currently has no app_id/read-state columns. We count rows whose
  // saved URL points at /p/:slug for one of the workspace apps, and because
  // there's no read marker yet every matched row is "unread" by definition.
  const feedbackRows = db
    .prepare('SELECT url FROM feedback ORDER BY created_at DESC')
    .all() as Array<{ url: string | null }>;
  let feedbackUnread = 0;
  const feedbackApps = new Set<string>();
  for (const row of feedbackRows) {
    const slug = feedbackAppSlugFromUrl(row.url);
    if (!slug || !appSlugs.has(slug)) continue;
    feedbackUnread += 1;
    feedbackApps.add(slug);
  }

  const activeCount = apps.filter((app) => isStudioAppLive(app.publish_status)).length;
  const draftCount = apps.length - activeCount;

  return c.json({
    workspace: {
      member_count: workspaceMemberCount,
    },
    runs_7d: {
      count: runsCurrent,
      previous_count: runsPrevious,
      delta_pct: studioRunsDeltaPct(runsCurrent, runsPrevious),
    },
    apps: {
      total_count: apps.length,
      active_count: activeCount,
      draft_count: draftCount,
      items: apps.map((app) => ({
        slug: app.slug,
        name: app.name,
        icon: app.icon,
        publish_status: app.publish_status,
        visibility: app.visibility,
        created_at: app.created_at,
        updated_at: app.updated_at,
        last_run_at: app.last_run_at,
        runs_7d: Number(app.runs_7d || 0),
      })),
    },
    feedback: {
      unread_count: feedbackUnread,
      apps_count: feedbackApps.size,
    },
  });
});

meRouter.get('/studio/activity', async (c) => {
  const ctx = await resolveUserContext(c);
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') || 5)));
  const apps = loadStudioApps(ctx);
  const appIds = apps.map((app) => app.id);

  if (appIds.length === 0) {
    return c.json({ runs: [] });
  }

  const placeholders = appIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT runs.id, runs.action, runs.status, runs.duration_ms, runs.started_at,
              runs.error, runs.user_id, runs.device_id,
              apps.slug AS app_slug, apps.name AS app_name, apps.icon AS app_icon,
              users.email AS user_email, users.name AS user_name
         FROM runs
         JOIN apps ON apps.id = runs.app_id
         LEFT JOIN users ON users.id = runs.user_id
        WHERE runs.app_id IN (${placeholders})
        ORDER BY runs.started_at DESC
        LIMIT ?`,
    )
    .all(...appIds, limit) as Array<{
    id: string;
    action: string;
    status: string;
    duration_ms: number | null;
    started_at: string;
    error: string | null;
    user_id: string | null;
    device_id: string | null;
    app_slug: string;
    app_name: string;
    app_icon: string | null;
    user_email: string | null;
    user_name: string | null;
  }>;

  return c.json({
    runs: rows.map((row) => ({
      id: row.id,
      action: row.action,
      status: row.status,
      duration_ms: row.duration_ms,
      started_at: row.started_at,
      error: row.error,
      app_slug: row.app_slug,
      app_name: row.app_name,
      app_icon: row.app_icon,
      user_label:
        row.user_email ||
        row.user_name ||
        (row.device_id ? 'Anonymous user' : 'Unknown user'),
      // The current runs schema does not persist Claude/Cursor/API provenance.
      // Returning a truthful umbrella label beats fabricating a finer source.
      source_label: 'Floom',
    })),
  });
});

meRouter.get('/runs', async (c) => {
  const ctx = await resolveUserContext(c);
  const limit = Math.max(1, Math.min(200, Number(c.req.query('limit') || 50)));

  // Two filters: authenticated caller scopes by user_id; anonymous caller
  // scopes by device_id. Both also check workspace_id so cross-workspace
  // leaks are impossible.
  const filter: RunListFilter = { workspace_id: ctx.workspace_id, limit };
  if (ctx.is_authenticated) {
    filter.user_id = ctx.user_id;
  } else if (ctx.device_id) {
    (filter as any).device_id = ctx.device_id;
  }
  const runs = storage.listRuns(filter);
  const rows = runs.map(run => {
    const app = storage.getAppById(run.app_id);
    return {
      ...run,
      app_slug: app?.slug ?? null,
      app_name: app?.name ?? null,
      app_icon: app?.icon ?? null,
    };
  });

  return c.json({
    runs: rows.map((r) => {
      // v15.1 /me uses inputs to derive a human-readable thread title
      // without a per-row detail fetch. Parse defensively — older rows
      // may have malformed or missing JSON.
      let inputs: Record<string, unknown> | null = null;
      if (r.inputs) {
        try {
          const parsed = JSON.parse(r.inputs);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            inputs = parsed as Record<string, unknown>;
          }
        } catch {
          // Swallow parse errors: a bad inputs blob shouldn't break the
          // whole /runs list. UI will fall back to "Run #<id>".
        }
      }
      // Fix 3 (2026-04-19): surface `outputs` on the list response so the
      // earlier-runs rail on /p/:slug can render input → output previews
      // without a per-row detail fetch. Outputs can be arbitrary shapes;
      // the UI calls JSON.stringify() + truncates on the client side.
      let outputs: unknown = null;
      if (r.outputs) {
        try {
          outputs = JSON.parse(r.outputs);
        } catch {
          outputs = r.outputs; // surface as raw string so snippet is visible
        }
      }
      return {
        id: r.id,
        action: r.action,
        status: r.status,
        duration_ms: r.duration_ms,
        started_at: r.started_at,
        finished_at: r.finished_at,
        error: r.error,
        error_type: r.error_type,
        app_slug: r.app_slug,
        app_name: r.app_name,
        app_icon: r.app_icon,
        inputs,
        outputs,
      };
    }),
  });
});

// GET /api/me/runs/:id — scoped fetch of a single run. Returns 404 if the
// run exists but is owned by someone else, so probing run ids can't leak
// another user's outputs.
meRouter.get('/runs/:id', async (c) => {
  const ctx = await resolveUserContext(c);
  const id = c.req.param('id');
  const run = storage.getRun(id);
  if (!run || run.workspace_id !== ctx.workspace_id) return c.json({ error: 'Run not found' }, 404);
  if (ctx.is_authenticated) {
    if (run.user_id !== ctx.user_id) return c.json({ error: 'Run not found' }, 404);
  } else {
    if (run.device_id !== ctx.device_id) return c.json({ error: 'Run not found' }, 404);
  }
  const app = storage.getAppById(run.app_id);
  const row = {
    ...run,
    app_slug: app?.slug ?? null,
    app_name: app?.name ?? null,
    app_icon: app?.icon ?? null,
  };

  return c.json({
    id: row.id,
    app_id: row.app_id,
    app_slug: row.app_slug,
    app_name: row.app_name,
    app_icon: row.app_icon,
    thread_id: row.thread_id,
    action: row.action,
    inputs: safeParse(row.inputs),
    outputs: safeParse(row.outputs),
    status: row.status,
    error: row.error,
    error_type: row.error_type,
    upstream_status: row.upstream_status ?? null,
    duration_ms: row.duration_ms,
    started_at: row.started_at,
    finished_at: row.finished_at,
    logs: row.logs,
  });
});
