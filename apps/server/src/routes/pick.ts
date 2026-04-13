// POST /api/pick — natural-language prompt → top 3 matching apps.
import { Hono } from 'hono';
import { pickApps } from '../services/embeddings.js';

export const pickRouter = new Hono();

pickRouter.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    prompt?: unknown;
    limit?: unknown;
  };
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return c.json({ error: '"prompt" is required' }, 400);
  }
  const limit =
    typeof body.limit === 'number' && body.limit > 0 && body.limit <= 10 ? body.limit : 3;
  const apps = await pickApps(body.prompt, limit);
  return c.json({ apps });
});
