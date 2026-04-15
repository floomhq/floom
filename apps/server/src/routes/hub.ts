// GET /api/hub — list every runnable app in this Floom instance.
// This is the "15 apps" grid for the apps directory page.
// W4-minimal additions:
//   POST   /api/hub/ingest       — one-shot URL-based publish for /build
//   POST   /api/hub/detect       — spec preview for /build Step 2
//   DELETE /api/hub/:slug        — creator-only delete
//   GET    /api/hub/mine         — apps owned by the caller's workspace
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db.js';
import { resolveUserContext } from '../services/session.js';
import { detectAppFromUrl, ingestAppFromUrl } from '../services/openapi-ingest.js';
import type { AppRecord, NormalizedManifest } from '../types.js';

export const hubRouter = new Hono();

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
  description: z.string().max(500).optional(),
  slug: z
    .string()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  category: z.string().max(48).optional(),
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
  const slug = c.req.param('slug');

  const app = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  if (!app) return c.json({ error: 'App not found' }, 404);

  // Only the author can delete. Synthetic local can delete anything in
  // OSS mode so a self-hoster can clean up manually.
  const isOwner = app.author === ctx.user_id || ctx.workspace_id === 'local';
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
  const sort = c.req.query('sort') || 'name';
  let orderBy = 'name ASC';
  if (sort === 'newest') orderBy = 'created_at DESC';
  if (sort === 'category') orderBy = 'category, name';

  const sql = `SELECT * FROM apps WHERE status = 'active' ${
    category ? 'AND category = ?' : ''
  } ORDER BY ${orderBy}`;
  const rows = (category
    ? db.prepare(sql).all(category)
    : db.prepare(sql).all()) as AppRecord[];

  return c.json(
    rows.map((row) => {
      const manifest = safeManifest(row.manifest);
      return {
        slug: row.slug,
        name: row.name,
        description: row.description,
        category: row.category,
        author: row.author,
        icon: row.icon,
        actions: manifest ? Object.keys(manifest.actions) : [],
        runtime: manifest?.runtime ?? 'python',
        created_at: row.created_at,
        // Optional annotation for self-host blocked apps. Present only when
        // the manifest explicitly declares a blocked_reason. Surfaced on the
        // store card as a warning pill so users know the app is not
        // runnable in this environment. See docs/APPS-STATUS.md.
        ...(manifest?.blocked_reason
          ? { blocked_reason: manifest.blocked_reason }
          : {}),
      };
    }),
  );
});

hubRouter.get('/:slug', (c) => {
  const slug = c.req.param('slug');
  const row = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  if (!row) return c.json({ error: 'App not found' }, 404);
  const manifest = safeManifest(row.manifest);
  return c.json({
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    author: row.author,
    icon: row.icon,
    manifest,
    created_at: row.created_at,
  });
});

function safeManifest(raw: string): NormalizedManifest | null {
  try {
    return JSON.parse(raw) as NormalizedManifest;
  } catch {
    return null;
  }
}
