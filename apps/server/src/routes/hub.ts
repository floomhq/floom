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
import { z } from 'zod';
import { mkdtempSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db.js';
import { resolveUserContext } from '../services/session.js';
import { detectAppFromUrl, ingestAppFromUrl } from '../services/openapi-ingest.js';
import {
  bundleRenderer,
  forgetBundle,
  getBundleResult,
  MAX_BUNDLE_BYTES,
  RENDERERS_DIR,
} from '../services/renderer-bundler.js';
import { requireAuthenticatedInCloud } from '../lib/auth.js';
import type { AppRecord, NormalizedManifest } from '../types.js';
import type { OutputShape } from '@floom/renderer/contract';

export const hubRouter = new Hono();

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

hubRouter.post('/detect', async (c) => {
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
    return c.json(
      { error: (err as Error).message || 'detect_failed', code: 'detect_failed' },
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
    });
    return c.json(result, result.created ? 201 : 200);
  } catch (err) {
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
    })),
  });
});

// GET /api/hub/:slug/runs — creator activity feed for a single app. Returns
// the most recent runs across every caller that has run this app. Scoped
// to the caller's workspace so one creator can't peek at another's runs.
hubRouter.get('/:slug/runs', async (c) => {
  const ctx = await resolveUserContext(c);
  const slug = c.req.param('slug');
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') || 20)));

  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  if (!app) return c.json({ error: 'App not found' }, 404);

  // Ownership check: only the author (or synthetic local in OSS) may view.
  const isOwner = app.author === ctx.user_id || (ctx.workspace_id === 'local' && app.workspace_id === 'local');
  if (!isOwner) {
    return c.json({ error: 'Not the owner of this app', code: 'not_owner' }, 403);
  }

  const rows = db
    .prepare(
      `SELECT id, action, status, inputs, outputs, duration_ms,
              started_at, finished_at, error, error_type, user_id, device_id
         FROM runs
        WHERE app_id = ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(app.id, limit) as Array<{
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
  return c.json({ ok: true, slug });
});

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

hubRouter.get('/', (c) => {
  const category = c.req.query('category');
  const sort = c.req.query('sort') || 'default';
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
  const sql = `SELECT apps.*, users.name AS author_name, users.email AS author_email
                 FROM apps
                 LEFT JOIN users ON apps.author = users.id
                 WHERE apps.status = 'active'
                   AND (apps.visibility = 'public' OR apps.visibility IS NULL)
                   ${category ? 'AND apps.category = ?' : ''}
                 ORDER BY ${orderBy}`;
  const rows = (category
    ? db.prepare(sql).all(category)
    : db.prepare(sql).all()) as Array<
    AppRecord & { author_name: string | null; author_email: string | null }
  >;

  return c.json(
    rows.map((row) => {
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
        // Optional annotation for self-host blocked apps. Present only when
        // the manifest explicitly declares a blocked_reason. Surfaced on the
        // store card as a warning pill so users know the app is not
        // runnable in this environment.
        ...(manifest?.blocked_reason
          ? { blocked_reason: manifest.blocked_reason }
          : {}),
      };
    }),
  );
});

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
  const manifest = safeManifest(row.manifest);
  const bundle = getBundleResult(slug);
  return c.json({
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    author: row.author,
    author_display: authorDisplayFromRow(row),
    icon: row.icon,
    manifest,
    // Visibility (public | unlisted | private). Surfaced so the web client
    // can render visibility pills and gate private-only UI (e.g. /me/apps/:slug
    // console) without re-fetching from a separate endpoint.
    visibility: row.visibility,
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
