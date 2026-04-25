// POST /api/parse — natural-language prompt → structured inputs for a specific app.
import { Hono } from 'hono';
import { storage } from '../services/storage.js';
import { parsePrompt } from '../services/parser.js';
import type { AppRecord, NormalizedManifest } from '../types.js';

export const parseRouter = new Hono();

parseRouter.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    prompt?: unknown;
    app_slug?: unknown;
    action?: unknown;
  };
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return c.json({ error: '"prompt" is required' }, 400);
  }
  if (typeof body.app_slug !== 'string' || !body.app_slug.trim()) {
    return c.json({ error: '"app_slug" is required' }, 400);
  }

  const row = storage.getApp(body.app_slug);
  if (!row) return c.json({ error: `App not found: ${body.app_slug}` }, 404);

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

  const result = await parsePrompt(body.prompt, row.name, actionSpec);
  return c.json({
    app_slug: row.slug,
    action: actionName,
    inputs: result.inputs,
    confidence: result.confidence,
    reasoning: result.reasoning,
  });
});
