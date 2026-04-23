// GET /api/hub — list every runnable app in this Floom instance.
// Backs the /apps directory page grid.
// W4-minimal additions:
//   POST   /api/hub/ingest              — one-shot URL-based publish for /build
//   POST   /api/hub/detect              — spec preview for /build Step 2
//   DELETE /api/hub/:slug               — creator-only delete
//   GET    /api/hub/mine                — apps owned by the caller's workspace
// W2.2 custom-renderer re-enable:
//   POST   /api/hub/:slug/renderer      — upload a creator TSX renderer
//   DELETE /api/hub/:slug/renderer      — drop the custom renderer, fall back to default
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { mkdtempSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db.js';
import { resolveUserContext } from '../services/session.js';
import {
  buildIngestHint,
  detectAppFromInlineSpec,
  detectAppFromUrl,
  ingestAppFromUrl,
  SlugTakenError,
  SpecNotFoundError,
} from '../services/openapi-ingest.js';
import {
  bundleRenderer,
  forgetBundle,
  getBundleResult,
  MAX_BUNDLE_BYTES,
  RENDERERS_DIR,
} from '../services/renderer-bundler.js';
import { requireAuthenticatedInCloud } from '../lib/auth.js';
import { filterTestFixtures } from '../lib/hub-filter.js';
import {
  getHubCache,
  hubCacheKey,
  invalidateHubCache,
  setHubCache,
} from '../lib/hub-cache.js';
import type { AppRecord, NormalizedManifest } from '../types.js';
import type { OutputShape } from '@floom/renderer/contract';

export const hubRouter = new Hono();

/**
 * Pull just the host out of a proxied app's base_url, for the
 * `/api/hub/:slug` response. Used by the /p/:slug runner surface to
 * render "Can't reach {host}" on a network_unreachable error. Host only
 * — not path, not query, not creds — so there's nothing sensitive to
 * leak even for private apps. Returns null for docker apps (no
 * base_url) or malformed URLs.
 */
function deriveUpstreamHost(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

function authorDisplayFromRow(
  row: AppRecord & { author_name?: string | null; author_email?: string | null },
): string | null {
  if (row.author_name && String(row.author_name).trim()) {
    return String(row.author_name).trim();
  }
  const em = row.author_email;
  if (em && em.includes('@')) {
    const local = em.split('@')[0];
    if (local) return local;
  }
  return null;
}

// ---------------------------------------------------------------------
// Detect + ingest (creator publish flow)
// ---------------------------------------------------------------------

const DetectBody = z.object({
  openapi_url: z.string().url().max(2048),
  name: z.string().min(1).max(120).optional(),
  slug: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
});

const IngestBody = z.object({
  openapi_url: z.string().url().max(2048),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(5000).optional(),
  slug: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  category: z.string().max(48).optional(),
  visibility: z.enum(['public', 'private', 'auth-required']).optional(),
});

// SECURITY (issue #378, pentest 2026-04-22): /detect fetches a user-supplied
// URL server-side, which is a classic SSRF primitive. Two hardenings:
//   1. Auth gate (Cloud mode): anon callers get a 401, so the capability to
//      "make our server fetch a URL" is not exposed to the public internet.
//      OSS self-host keeps the legacy behavior (no auth configured = no-op).
//   2. Private-network / loopback / link-local blocks + response size cap +
//      timeout live in `fetchSpec` (services/openapi-ingest.ts), so every
//      caller of fetchSpec benefits, not just /detect.
hubRouter.post('/detect', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = DetectBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }
  try {
    const detected = await detectAppFromUrl(
      parsed.data.openapi_url,
      parsed.data.slug,
      parsed.data.name,
    );
    return c.json(detected);
  } catch (err) {
    // Issue #389: surface a specific `spec_not_found` code (with the list
    // of URLs we actually probed) so the client can show "We checked
    // these 5 URLs and none returned a spec" instead of a generic error.
    //
    // MEMORY (feedback_ingestion_be_helpful.md): every error path must
    // include a `hint_url` pointing at /detect/hint. The frontend uses it
    // to render a proactive recovery block (paste URL, paste contents,
    // ask-Claude prompt) instead of a dead-end error string.
    const hintUrl = `${resolveBaseUrlFromRequest(c)}/api/hub/detect/hint`;
    if (err instanceof SpecNotFoundError) {
      return c.json(
        {
          error: err.message,
          code: 'spec_not_found',
          attempted: err.attempted,
          hint_url: hintUrl,
        },
        404,
      );
    }
    return c.json(
      {
        error: (err as Error).message || 'detect_failed',
        code: 'detect_failed',
        hint_url: hintUrl,
      },
      400,
    );
  }
});

// -----------------------------------------------------------------------
// POST /api/hub/detect/hint
//   Proactive recovery endpoint (MEMORY: feedback_ingestion_be_helpful.md).
//   When /api/hub/detect fails (spec_not_found, unreachable, etc.), the
//   client should NOT render a dead-end error — it calls /hint and shows:
//     - what we looked for
//     - a one-paste prompt for a coding agent
//     - an upload URL for the generated spec
//     - a direct-URL re-detect endpoint
//   Intentionally no auth gate: the response is static metadata + a prompt
//   string, not an SSRF primitive.
//
// Body (all optional except input_url):
//   {
//     input_url: string,     // the repo or URL the user pasted
//     attempted?: string[]   // paths the frontend already probed
//   }
const HintBody = z.object({
  input_url: z.string().min(1).max(2048),
  attempted: z.array(z.string().max(2048)).max(40).optional(),
});

function resolveBaseUrlFromRequest(c: Context): string {
  // Prefer x-forwarded-proto + x-forwarded-host so we return the public
  // Floom URL (preview.floom.dev, floom.dev, localhost:3010, self-host),
  // not an internal hostname like the docker service name.
  const proto = c.req.header('x-forwarded-proto') || 'https';
  const host =
    c.req.header('x-forwarded-host') || c.req.header('host') || 'floom.dev';
  return `${proto}://${host}`;
}

hubRouter.post('/detect/hint', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = HintBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }
  const hint = buildIngestHint({
    input_url: parsed.data.input_url,
    attempted: parsed.data.attempted,
    baseUrl: resolveBaseUrlFromRequest(c),
  });
  return c.json(hint);
});

// -----------------------------------------------------------------------
// POST /api/hub/detect/inline
//   The "paste contents / upload spec" recovery path and the endpoint a
//   coding agent POSTs a freshly-generated spec to. Body:
//     { openapi_spec: object | string, name?: string, slug?: string }
//   Same auth gate as /detect — inline specs don't issue outbound
//   fetches so SSRF isn't a concern, but we keep the cloud auth gate for
//   symmetry with the rest of the detect/ingest flow.
const InlineDetectBody = z.object({
  openapi_spec: z.union([z.record(z.any()), z.string().min(1).max(2 * 1024 * 1024)]),
  name: z.string().min(1).max(120).optional(),
  slug: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
});

hubRouter.post('/detect/inline', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = InlineDetectBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }
  try {
    const detected = await detectAppFromInlineSpec(
      parsed.data.openapi_spec,
      parsed.data.slug,
      parsed.data.name,
    );
    return c.json(detected);
  } catch (err) {
    return c.json(
      {
        error: (err as Error).message || 'inline_detect_failed',
        code: 'inline_detect_failed',
        hint_url: `${resolveBaseUrlFromRequest(c)}/api/hub/detect/hint`,
      },
      400,
    );
  }
});

hubRouter.post('/ingest', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = IngestBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }
  try {
    const result = await ingestAppFromUrl({
      openapi_url: parsed.data.openapi_url,
      name: parsed.data.name,
      description: parsed.data.description,
      slug: parsed.data.slug,
      category: parsed.data.category,
      visibility: parsed.data.visibility,
      workspace_id: ctx.workspace_id,
      author_user_id: ctx.user_id,
      allowPrivateNetwork: ctx.workspace_id === 'local' && ctx.user_id === 'local',
    });
    // Perf fix (2026-04-20): bust the /api/hub 5s cache so the newly
    // ingested (or re-ingested) app shows up in the public directory
    // immediately for the creator.
    invalidateHubCache();
    return c.json(result, result.created ? 201 : 200);
  } catch (err) {
    // Slug collision: 409 with three recovery suggestions (audit 2026-04-20,
    // Fix 2). The UI picks one as a pill or lets the user edit freely.
    if (err instanceof SlugTakenError) {
      return c.json(
        {
          error: err.message,
          code: err.code,
          slug: err.slug,
          suggestions: err.suggestions,
        },
        409,
      );
    }
    return c.json(
      { error: (err as Error).message || 'ingest_failed', code: 'ingest_failed' },
      400,
    );
  }
});

// GET /api/hub/mine — apps authored by the caller. In OSS mode the
// caller is the synthetic local user, and we return apps authored by
// 'local' OR with workspace_id='local'. In Cloud mode we filter on
// author = user_id.
hubRouter.get('/mine', async (c) => {
  const ctx = await resolveUserContext(c);
  const rows = db
    .prepare(
      `SELECT apps.*, (
         SELECT COUNT(*) FROM runs WHERE runs.app_id = apps.id
       ) AS run_count,
       (
         SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
       ) AS last_run_at
         FROM apps
        WHERE (apps.workspace_id = ? AND apps.author = ?)
           OR apps.author = ?
        ORDER BY apps.updated_at DESC`,
    )
    .all(ctx.workspace_id, ctx.user_id, ctx.user_id) as Array<
    AppRecord & { run_count: number; last_run_at: string | null }
  >;

  return c.json({
    apps: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      description: row.description,
      category: row.category,
      icon: row.icon,
      author: row.author,
      status: row.status,
      app_type: row.app_type,
      openapi_spec_url: row.openapi_spec_url,
      created_at: row.created_at,
      updated_at: row.updated_at,
      run_count: row.run_count || 0,
      last_run_at: row.last_run_at,
      // v15.2: surfaced so the /me rail + /me/apps/:slug header can render
      // the private pill and async-run hint without an extra /api/hub/:slug
      // fetch per list item. Additive — older clients ignore these fields.
      visibility: row.visibility,
      is_async: row.is_async === 1,
      // Manual publish-review gate (#362): surface the status so Studio
      // can render "Pending review" pills next to freshly-ingested apps.
      publish_status: row.publish_status,
    })),
  });
});

// GET /api/hub/:slug/runs — creator activity feed for a single app. Returns
// the most recent runs across every caller that has run this app. Scoped
// to the caller's workspace so one creator can't peek at another's runs.
//
// SECURITY (issue #124, 2026-04-19): in Cloud mode an unauthenticated caller
// falls back to the synthetic ('local', 'local') context, which used to
// match the OSS-mode escape hatch below and expose every other caller's
// run inputs + outputs. The fix is two-fold:
//   1. Require an authenticated session in Cloud mode (401 on anon).
//   2. Drop the 'local'+'local' escape hatch in Cloud mode; only strict
//      `app.author === ctx.user_id` ownership grants access.
// OSS mode (self-host, single-user, unauth) keeps the legacy behavior so
// a local self-hoster can still see their own runs without logging in.
hubRouter.get('/:slug/runs', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const slug = c.req.param('slug');
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') || 20)));

  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  if (!app) return c.json({ error: 'App not found' }, 404);

  // Ownership check:
  //   - Cloud mode: strict author match. The OSS 'local'+'local' escape
  //     hatch is unsafe here because every anon fallback context is
  //     (workspace_id='local', user_id='local') and seed apps carry
  //     workspace_id='local' too (see issue #124).
  //   - OSS mode: synthetic local user can see their own local-seeded
  //     apps without signing in.
  const isOssLocal = !ctx.is_authenticated && ctx.workspace_id === 'local';
  const isOwner =
    (!!app.author && app.author === ctx.user_id) ||
    (isOssLocal && app.workspace_id === 'local');
  if (!isOwner) {
    return c.json({ error: 'Not the owner of this app', code: 'not_owner' }, 403);
  }

  // SECURITY (issue #124, 2026-04-19): scope runs to the caller's own
  // rows. Even the app author must not see other callers' raw inputs +
  // outputs — those can contain secrets (passwords, API keys, PII).
  // Authed callers scope by user_id; OSS anon falls back to device_id.
  const scopeClause = ctx.is_authenticated
    ? 'AND user_id = ?'
    : 'AND device_id = ?';
  const scopeParam = ctx.is_authenticated ? ctx.user_id : ctx.device_id;
  const rows = db
    .prepare(
      `SELECT id, action, status, inputs, outputs, duration_ms,
              started_at, finished_at, error, error_type, user_id, device_id
         FROM runs
        WHERE app_id = ? ${scopeClause}
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(app.id, scopeParam, limit) as Array<{
    id: string;
    action: string;
    status: string;
    inputs: string | null;
    outputs: string | null;
    duration_ms: number | null;
    started_at: string;
    finished_at: string | null;
    error: string | null;
    error_type: string | null;
    user_id: string | null;
    device_id: string | null;
  }>;

  return c.json({
    app: {
      slug: app.slug,
      name: app.name,
      description: app.description,
      icon: app.icon,
    },
    runs: rows.map((r) => ({
      id: r.id,
      action: r.action,
      status: r.status,
      inputs: safeParse(r.inputs),
      outputs: safeParse(r.outputs),
      duration_ms: r.duration_ms,
      started_at: r.started_at,
      finished_at: r.finished_at,
      error: r.error,
      error_type: r.error_type,
      // Never leak the full user id or device cookie — return a short hash
      caller_hash: (r.user_id || r.device_id || 'unknown').slice(0, 8),
      is_self:
        (ctx.is_authenticated && r.user_id === ctx.user_id) ||
        (!ctx.is_authenticated && r.device_id === ctx.device_id),
    })),
  });
});

// GET /api/hub/:slug/runs-by-day?days=7 — creator sparkline series.
//
// Returns a zero-filled daily count of runs for this app over the last
// N days (1..90, default 7). Shape: `{ days: [{date:'YYYY-MM-DD', count:N}, ...] }`
// with `days.length === N`, ordered oldest → newest. Zero days are
// emitted explicitly so the client can render a bar with `min-height:2px`
// rather than skipping the day (which would distort the axis).
//
// Ownership: same rule as /:slug/runs — creator-only, with the legacy
// OSS-local escape hatch for self-hosters. Unlike /:slug/runs, we do
// NOT further scope by user_id/device_id: a 7-day count across every
// caller is not sensitive (no inputs / outputs, just counts) and is
// what the creator actually wants to see on their /studio card. The
// sparkline spec (v17 wireframe `studio-my-apps.html`) shows cross-
// caller activity — that's the whole point of "my app has traction".
//
// Wireframe parity (2026-04-23): drives the per-card 7-bar sparkline
// on /studio, replacing the single `run_count` + `last_run_at` pair
// that couldn't show temporal shape.
hubRouter.get('/:slug/runs-by-day', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const slug = c.req.param('slug');
  const daysParam = Number(c.req.query('days') || 7);
  const days = Math.max(1, Math.min(90, Number.isFinite(daysParam) ? Math.floor(daysParam) : 7));

  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  if (!app) return c.json({ error: 'App not found' }, 404);

  // Ownership check mirrors /:slug/runs exactly (issue #124 semantics).
  const isOssLocal = !ctx.is_authenticated && ctx.workspace_id === 'local';
  const isOwner =
    (!!app.author && app.author === ctx.user_id) ||
    (isOssLocal && app.workspace_id === 'local');
  if (!isOwner) {
    return c.json({ error: 'Not the owner of this app', code: 'not_owner' }, 403);
  }

  // Aggregate by UTC calendar day. SQLite's date() function truncates
  // a datetime to 'YYYY-MM-DD'. We bound the scan with a lower bound
  // so a creator with a 100k-row runs table doesn't pay a full-scan.
  // `started_at` is the run's creation timestamp (see runs schema in
  // db.ts) and is always set — it's indexed via idx_runs_app which
  // makes `app_id = ? AND started_at >= ?` a fast index scan.
  const windowStart = `date('now', '-${days - 1} days')`;
  const rows = db
    .prepare(
      `SELECT date(started_at) AS day, COUNT(*) AS count
         FROM runs
        WHERE app_id = ?
          AND date(started_at) >= ${windowStart}
        GROUP BY day
        ORDER BY day ASC`,
    )
    .all(app.id) as Array<{ day: string; count: number }>;

  // Zero-fill: build the full N-day window and populate from the
  // sparse result. Using UTC to match the SQLite `date()` truncation.
  const counts = new Map<string, number>(rows.map((r) => [r.day, r.count]));
  const out: Array<{ date: string; count: number }> = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
    out.push({ date: key, count: counts.get(key) ?? 0 });
  }

  return c.json({ slug: app.slug, days: out });
});

hubRouter.delete('/:slug', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const slug = c.req.param('slug');

  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  if (!app) return c.json({ error: 'App not found' }, 404);

  // Only the author can delete. The OSS "local self-hoster can delete
  // anything" escape hatch is scoped to OSS mode only; in Cloud mode the
  // global `workspace_id === 'local'` branch would let every anonymous
  // caller delete every app (since unauthenticated callers fall back to
  // the synthetic local workspace).
  const isOssLocal = !ctx.is_authenticated && ctx.workspace_id === 'local';
  const isOwner = app.author === ctx.user_id || isOssLocal;
  if (!isOwner) {
    return c.json({ error: 'Not the owner of this app', code: 'not_owner' }, 403);
  }

  db.prepare('DELETE FROM apps WHERE id = ?').run(app.id);
  // Runs are dropped by ON DELETE CASCADE (see db.ts CREATE TABLE runs).
  // Perf fix (2026-04-20): drop the /api/hub 5s cache so the deleted
  // app stops appearing in the directory immediately.
  invalidateHubCache();
  return c.json({ ok: true, slug });
});

// PATCH /api/hub/:slug — owner-only update of mutable app fields.
//
// Issue #129 (2026-04-19): creators need to flip an app between public and
// private after publish. Previously the only way to change visibility was
// re-ingesting the spec, which is destructive (loses runs). This endpoint
// lets the Studio UI toggle visibility without touching the manifest.
//
// Audit 2026-04-20 (Fix 3): also accepts `primary_action`, which pins one
// action key as the "start here" tab on /p/:slug for multi-action apps.
// Unlike visibility (a top-level apps column), primary_action lives inside
// the JSON `manifest` blob, so we round-trip through parse/update/write.
// Setting `null` or omitting the field clears it (falls back to first action).
//
// Only these two fields are mutable here today. Name/description/category
// edits still go through re-ingest so the updated_at bookkeeping stays
// tight; they can be added here later when the Studio grows inline-edit UI.
const PatchBody = z.object({
  visibility: z.enum(['public', 'private', 'auth-required']).optional(),
  // null clears; a string pins; omitted means "don't touch".
  primary_action: z.union([z.string().min(1).max(128), z.null()]).optional(),
});

hubRouter.patch('/:slug', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const slug = c.req.param('slug');

  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  if (!app) return c.json({ error: 'App not found' }, 404);

  // Ownership: same rule as DELETE. OSS local self-hoster bypass is scoped
  // to OSS mode only (see DELETE handler above for why).
  const isOssLocal = !ctx.is_authenticated && ctx.workspace_id === 'local';
  const isOwner = app.author === ctx.user_id || isOssLocal;
  if (!isOwner) {
    return c.json({ error: 'Not the owner of this app', code: 'not_owner' }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  if (parsed.data.visibility) {
    updates.push('visibility = ?');
    values.push(parsed.data.visibility);
  }

  // primary_action lives in the JSON manifest, not in its own column.
  // Parse, mutate, write. Validate that the declared primary exists in
  // `actions`; reject upfront so the 95% typo case doesn't silently
  // produce a manifest with an invalid primary_action (renderer would
  // just fall back to the first action, but the creator would think
  // they'd saved a pin).
  if (parsed.data.primary_action !== undefined) {
    const manifest = safeManifest(app.manifest);
    if (!manifest) {
      return c.json(
        { error: 'App has no parseable manifest', code: 'manifest_invalid' },
        409,
      );
    }
    if (parsed.data.primary_action === null) {
      delete (manifest as NormalizedManifest & { primary_action?: string }).primary_action;
    } else {
      if (!manifest.actions[parsed.data.primary_action]) {
        return c.json(
          {
            error: `primary_action "${parsed.data.primary_action}" is not a declared action`,
            code: 'invalid_primary_action',
            valid_actions: Object.keys(manifest.actions),
          },
          400,
        );
      }
      (manifest as NormalizedManifest & { primary_action?: string }).primary_action =
        parsed.data.primary_action;
    }
    updates.push('manifest = ?');
    values.push(JSON.stringify(manifest));
  }

  if (updates.length === 0) {
    return c.json({ error: 'No updatable fields in body', code: 'empty_patch' }, 400);
  }
  updates.push("updated_at = datetime('now')");
  values.push(app.id);

  db.prepare(`UPDATE apps SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  // Perf fix (2026-04-20): bust the /api/hub 5s cache so visibility /
  // primary_action changes land in the public directory immediately.
  invalidateHubCache();
  return c.json({
    ok: true,
    slug,
    visibility: parsed.data.visibility ?? app.visibility,
    primary_action:
      parsed.data.primary_action !== undefined ? parsed.data.primary_action : undefined,
  });
});

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// FLOOM_STORE_HIDE_SLUGS (lock-in 2026-04-18): comma-separated list of app
// slugs that the public store feed should suppress. Default empty, no
// filtering. Useful for creators who want to temporarily take a published
// app out of the directory without deleting it (e.g. `flyfast` while its
// upstream integration is being rotated). Parsed once at module load;
// change the env var and restart the server to pick up new values.
//
// INVARIANT (audit 2026-04-18, bug #1): this filter applies ONLY to the
// public directory list endpoint below (hubRouter.get('/')). It MUST NOT
// be applied to hubRouter.get('/:slug') (app detail), because hiding an
// app from the directory should not break its permalink at /p/:slug.
// If you add another endpoint that surfaces the full apps list, filter
// it here too; if you add one that serves a single-app record, leave the
// hide list alone. Direct permalinks keep working for hidden apps.
const HIDDEN_SLUGS: Set<string> = new Set(
  (process.env.FLOOM_STORE_HIDE_SLUGS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

hubRouter.get('/', (c) => {
  const category = c.req.query('category');
  const sort = c.req.query('sort') || 'default';
  // Issue #144: `?include_fixtures=true` bypasses the E2E/PRR fixture
  // filter. Admin-only use (we don't currently auth-gate it because the
  // fixtures themselves aren't sensitive — just noisy). Any truthy value
  // disables the filter.
  const includeFixtures = c.req.query('include_fixtures') === 'true';

  // Perf launch-blocker fix (2026-04-20): serve from the 5s in-memory
  // cache when we have a fresh entry for this (category, sort,
  // includeFixtures) tuple. See lib/hub-cache.ts for the full rationale.
  const cacheKey = hubCacheKey(category ?? null, sort, includeFixtures);
  const cached = getHubCache(cacheKey);
  if (cached !== null) {
    return c.json(cached);
  }
  // Default store sort (fast-apps wave):
  //   1. featured desc   — pinned apps always first
  //   2. avg_run_ms asc  — fastest apps next (NULLs last so unmeasured
  //      apps do not jump the queue on a default table)
  //   3. created_at desc — newest third
  //   4. name asc        — deterministic tiebreak
  // `sort=name`, `sort=newest`, `sort=category` remain supported for
  // creator views that want a predictable lexical order.
  let orderBy =
    'apps.featured DESC, (apps.avg_run_ms IS NULL) ASC, apps.avg_run_ms ASC, apps.created_at DESC, apps.name ASC';
  if (sort === 'name') orderBy = 'apps.name ASC';
  if (sort === 'newest') orderBy = 'apps.created_at DESC';
  if (sort === 'category') orderBy = 'apps.category, apps.name';

  // Public directory: only apps with visibility='public' (or NULL for
  // legacy rows). Private apps are surfaced exclusively via /api/hub/mine.
  // Manual publish-review gate (#362): only 'published' apps are listed.
  // 'pending_review' / 'rejected' / 'draft' apps are hidden from the
  // public Store regardless of visibility — the creator still sees them
  // on /api/hub/mine.
  // Wireframe parity (2026-04-23): `runs_7d` is a correlated subquery
  // against the runs table, aggregated at read time. No staleness window,
  // no separate column. The 5-second /api/hub in-memory cache absorbs
  // the repeated cost in practice. `stars`, `hero`, `thumbnail_url` are
  // plain row columns (see db.ts migration 2026-04-23).
  const sql = `SELECT apps.*,
                      users.name AS author_name,
                      users.email AS author_email,
                      (
                        SELECT COUNT(*) FROM runs
                         WHERE runs.app_id = apps.id
                           AND date(runs.started_at) >= date('now','-6 days')
                      ) AS runs_7d
                 FROM apps
                 LEFT JOIN users ON apps.author = users.id
                 WHERE apps.status = 'active'
                   AND (apps.visibility = 'public' OR apps.visibility IS NULL)
                   AND apps.publish_status = 'published'
                   ${category ? 'AND apps.category = ?' : ''}
                 ORDER BY ${orderBy}`;
  const rowsAll = (category
    ? db.prepare(sql).all(category)
    : db.prepare(sql).all()) as Array<
    AppRecord & {
      author_name: string | null;
      author_email: string | null;
      runs_7d: number;
    }
  >;

  // Apply FLOOM_STORE_HIDE_SLUGS server-side filter first. This is the
  // canonical place to hide apps from the public directory; the
  // client-side `isTestFixture` pass in AppsDirectoryPage stays as a
  // defense-in-depth safety net against test fixtures accidentally
  // ingested in dev.
  const rowsHidden =
    HIDDEN_SLUGS.size === 0
      ? rowsAll
      : rowsAll.filter((row) => !HIDDEN_SLUGS.has(row.slug.toLowerCase()));

  // Issue #144: strip E2E / PRR / audit test fixtures unless the caller
  // explicitly opted in via `?include_fixtures=true`. Previously this
  // filter lived client-side only (apps/web/src/lib/hub-filter.ts), which
  // meant raw `curl /api/hub` + MCP `list_apps` callers saw 13+ fixture
  // slugs like `e2e-stopwatch-*`, `my-renderer-test`, `swagger-petstore`.
  const rows = includeFixtures ? rowsHidden : filterTestFixtures(rowsHidden);

  const body = rows.map((row) => {
    const manifest = safeManifest(row.manifest);
    return {
      slug: row.slug,
      name: row.name,
      description: row.description,
      category: row.category,
      author: row.author,
      author_display: authorDisplayFromRow(row),
      icon: row.icon,
      actions: manifest ? Object.keys(manifest.actions) : [],
      runtime: manifest?.runtime ?? 'python',
      created_at: row.created_at,
      // Fast-apps wave fields. `featured` is coerced to boolean for the
      // JSON response so clients do not have to deal with 0/1. `avg_run_ms`
      // stays nullable because an app that has never run has no average.
      featured: row.featured === 1,
      avg_run_ms: row.avg_run_ms,
      // Wireframe parity (2026-04-23) — v17 store.html card fields.
      //   thumbnail_url: 640x360 PNG; null means the client renders the
      //     gradient fallback tile.
      //   stars: non-negative int. `hot_star` on the wireframe is any
      //     app with stars>=100; that's a pure render-time decision.
      //   hero: boolean mapped from SQLite 0/1, flips the accent "HERO"
      //     tag on the card.
      //   runs_7d: count of runs started in the last 7 UTC days
      //     (correlated subquery in SELECT). Always a non-negative int.
      thumbnail_url: row.thumbnail_url ?? null,
      stars: row.stars ?? 0,
      hero: row.hero === 1,
      runs_7d: row.runs_7d ?? 0,
      // Optional annotation for self-host blocked apps. Present only when
      // the manifest explicitly declares a blocked_reason. Surfaced on the
      // store card as a warning pill so users know the app is not
      // runnable in this environment.
      ...(manifest?.blocked_reason
        ? { blocked_reason: manifest.blocked_reason }
        : {}),
    };
  });

  // Perf launch-blocker fix (2026-04-20): park the body in the 5s
  // cache so subsequent requests for this (category, sort,
  // includeFixtures) tuple skip the SELECT + manifest parse entirely.
  setHubCache(cacheKey, body);

  return c.json(body);
});

// GET /api/hub/:slug — single-app detail.
//
// Note (audit 2026-04-18, bug #1): this endpoint intentionally does NOT
// consult HIDDEN_SLUGS. A slug in FLOOM_STORE_HIDE_SLUGS is suppressed
// from the public directory list, but its permalink /p/:slug must still
// resolve. The only ownership-scoped 404 is for visibility='private'
// apps (see below).
hubRouter.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const row = db
    .prepare(
      `SELECT apps.*, users.name AS author_name, users.email AS author_email
         FROM apps
         LEFT JOIN users ON apps.author = users.id
        WHERE apps.slug = ?`,
    )
    .get(slug) as
    | (AppRecord & { author_name: string | null; author_email: string | null })
    | undefined;
  if (!row) return c.json({ error: 'App not found' }, 404);
  // Private app? Only reveal to its owner. Return 404 (not 403) so we
  // don't leak the slug's existence to strangers.
  if (row.visibility === 'private') {
    const ctx = await resolveUserContext(c);
    if (!row.author || ctx.user_id !== row.author) {
      return c.json({ error: 'App not found' }, 404);
    }
  }
  // Manual publish-review gate (#362): non-published public/auth-required
  // apps are only reachable by their owner. Strangers get a 404 so we
  // don't leak that a pending_review slug exists. Private apps already
  // passed their own owner check above and are exempt from this gate
  // (publish_status is orthogonal to visibility).
  if (row.visibility !== 'private' && row.publish_status !== 'published') {
    const ctx = await resolveUserContext(c);
    const isOwner = !!row.author && ctx.user_id === row.author;
    if (!isOwner) {
      return c.json({ error: 'App not found' }, 404);
    }
  }
  const manifest = safeManifest(row.manifest);
  const bundle = getBundleResult(slug);
  // Release-version metadata for the /p/:slug hero. Derived from the
  // manifest (creator-declared `version`) with a 0.1.0 fallback so every
  // app can display a sensible version chip without a schema migration.
  // `version_status` is hardcoded to 'stable' today — in v1.1 the Studio
  // publish flow will emit 'beta' / 'draft' here. `creator_handle` is the
  // public handle shown after "by @" in the hero; we reuse the existing
  // authorDisplayFromRow logic and strip a leading `@` if present.
  const manifestVersion =
    manifest && typeof (manifest as unknown as { version?: unknown }).version === 'string'
      ? ((manifest as unknown as { version: string }).version)
      : null;
  const displayAuthor = authorDisplayFromRow(row);
  const creatorHandle = displayAuthor ? displayAuthor.replace(/^@/, '') : null;
  return c.json({
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    author: row.author,
    author_display: displayAuthor,
    creator_handle: creatorHandle,
    version: manifestVersion || '0.1.0',
    version_status: 'stable' as const,
    published_at: row.created_at,
    icon: row.icon,
    manifest,
    // Visibility (public | unlisted | private). Surfaced so the web client
    // can render visibility pills and gate private-only UI (e.g. /me/apps/:slug
    // console) without re-fetching from a separate endpoint.
    visibility: row.visibility,
    // Error taxonomy (2026-04-20): expose the upstream host so the
    // /p/:slug runner surface can render "Can't reach {host}" on a
    // network_unreachable failure instead of a generic "its backend"
    // fallback. Only populated for proxied apps (OpenAPI-ingested);
    // docker apps don't have a base_url. We surface the bare host
    // (not the full URL with creds) so there's nothing sensitive to
    // leak even on private apps.
    upstream_host: deriveUpstreamHost(row.base_url),
    // Async job queue (v0.3.0). Surfaced so the web client switches to the
    // queued/running/succeeded poll UI when the app opts in. Backend routes
    // (POST /api/:slug/jobs + GET /api/:slug/jobs/:id) are already live.
    is_async: row.is_async === 1,
    async_mode: row.async_mode,
    timeout_ms: row.timeout_ms,
    // W2.2: expose renderer metadata so /p/:slug knows whether to lazy-load
    // /renderer/:slug/bundle.js (creator-supplied) or fall back to the
    // default OutputPanel. Null when no custom renderer is compiled.
    renderer: bundle
      ? {
          source_hash: bundle.sourceHash,
          bytes: bundle.bytes,
          output_shape: bundle.outputShape,
          compiled_at: bundle.compiledAt,
        }
      : null,
    created_at: row.created_at,
  });
});

// ---------------------------------------------------------------------
// Custom renderer upload / delete (W2.2 re-enable)
// ---------------------------------------------------------------------

const MAX_SOURCE_BYTES = 512 * 1024;
const OUTPUT_SHAPES: OutputShape[] = [
  'text',
  'markdown',
  'code',
  'table',
  'object',
  'image',
  'pdf',
  'audio',
  'stream',
  'error',
];

const RendererBody = z.object({
  source: z.string().min(1).max(MAX_SOURCE_BYTES),
  output_shape: z.enum(OUTPUT_SHAPES as [OutputShape, ...OutputShape[]]).optional(),
});

hubRouter.post('/:slug/renderer', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const slug = c.req.param('slug');
  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);

  const isOssLocal = !ctx.is_authenticated && ctx.workspace_id === 'local';
  const isOwner = app.author === ctx.user_id || isOssLocal;
  if (!isOwner) {
    return c.json({ error: 'Not the owner of this app', code: 'not_owner' }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = RendererBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }

  // Write source to an isolated temp dir so bundleRenderer (which reads from
  // disk) can resolve it. The temp dir is removed on any outcome.
  const sourceBytes = Buffer.byteLength(parsed.data.source, 'utf-8');
  if (sourceBytes > MAX_SOURCE_BYTES) {
    return c.json(
      { error: `Source exceeds ${MAX_SOURCE_BYTES} bytes`, code: 'too_large' },
      413,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), `floom-renderer-${slug}-`));
  const entryPath = join(dir, 'renderer.tsx');
  try {
    writeFileSync(entryPath, parsed.data.source, 'utf-8');
    const result = await bundleRenderer({
      slug,
      entryPath,
      outputShape: parsed.data.output_shape,
    });
    return c.json({
      slug: result.slug,
      bytes: result.bytes,
      source_hash: result.sourceHash,
      output_shape: result.outputShape,
      compiled_at: result.compiledAt,
    });
  } catch (err) {
    return c.json(
      {
        error: (err as Error).message || 'bundle_failed',
        code: 'bundle_failed',
      },
      400,
    );
  } finally {
    try {
      unlinkSync(entryPath);
    } catch {
      /* ignore */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

hubRouter.delete('/:slug/renderer', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const slug = c.req.param('slug');
  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);

  const isOssLocal = !ctx.is_authenticated && ctx.workspace_id === 'local';
  const isOwner = app.author === ctx.user_id || isOssLocal;
  if (!isOwner) {
    return c.json({ error: 'Not the owner of this app', code: 'not_owner' }, 403);
  }

  const bundlePath = join(RENDERERS_DIR, `${slug}.js`);
  for (const p of [bundlePath, `${bundlePath}.hash`, `${bundlePath}.shape`]) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
  forgetBundle(slug);
  return c.json({ ok: true, slug });
});

// Exposed for tests that want to confirm the cap is enforced without
// re-deriving the constant.
export const RENDERER_MAX_SOURCE_BYTES = MAX_SOURCE_BYTES;
export const RENDERER_MAX_BUNDLE_BYTES = MAX_BUNDLE_BYTES;

function safeManifest(raw: string): NormalizedManifest | null {
  try {
    return JSON.parse(raw) as NormalizedManifest;
  } catch {
    return null;
  }
}
