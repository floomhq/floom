// GET /api/hub — list every runnable app in the chat instance.
// This is the "15 apps" grid for the Browse page.
import { Hono } from 'hono';
import { db } from '../db.js';
import type { AppRecord, NormalizedManifest } from '../types.js';

export const hubRouter = new Hono();

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
