// W2.1 memory + secrets routes.
//
// Exposes two surfaces:
//
//   /api/memory/:app_slug         — per-user app memory (key/value JSON store)
//   /api/secrets                  — per-user secrets vault (AES-256-GCM)
//
// Both routers resolve a SessionContext in middleware so every query carries
// a `workspace_id`. In OSS mode the context is always
// `{ workspace_id: 'local', user_id: 'local', device_id: <cookie> }`; Cloud
// (post-W3.1) overrides this without changing the routes.
//
// Error envelope: `{error: string, code?: string, details?: unknown}`.
// Never returns raw stack traces.
import { Hono } from 'hono';
import { z } from 'zod';
import { resolveUserContext } from '../services/session.js';
import * as appMemory from '../services/app_memory.js';
import * as userSecrets from '../services/user_secrets.js';
import { MemoryKeyNotAllowedError } from '../services/app_memory.js';
import { SecretDecryptError } from '../services/user_secrets.js';
import { requireAuthenticatedInCloud } from '../lib/auth.js';

export const memoryRouter = new Hono();

const MemorySetBody = z.object({
  key: z.string().min(1).max(128),
  value: z.unknown(),
});

/**
 * GET /api/memory/:app_slug — list all memory keys for this user on this app.
 * Returns `{ entries: Record<string, any> }`.
 */
memoryRouter.get('/:app_slug', async (c) => {
  const ctx = await resolveUserContext(c);
  const slug = c.req.param('app_slug') || '';
  try {
    const entries = appMemory.list(ctx, slug);
    return c.json({ entries });
  } catch (err) {
    return c.json(
      { error: (err as Error).message, code: 'memory_list_failed' },
      500,
    );
  }
});

/**
 * POST /api/memory/:app_slug — upsert a single memory key.
 */
memoryRouter.post('/:app_slug', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const slug = c.req.param('app_slug') || '';
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = MemorySetBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      400,
    );
  }
  try {
    appMemory.set(ctx, slug, parsed.data.key, parsed.data.value);
    return c.json({ ok: true, key: parsed.data.key });
  } catch (err) {
    if (err instanceof MemoryKeyNotAllowedError) {
      return c.json(
        {
          error: err.message,
          code: 'memory_key_not_allowed',
          details: { allowed: err.allowed },
        },
        403,
      );
    }
    return c.json(
      { error: (err as Error).message, code: 'memory_set_failed' },
      500,
    );
  }
});

/**
 * DELETE /api/memory/:app_slug/:key — remove a single key.
 */
memoryRouter.delete('/:app_slug/:key', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const slug = c.req.param('app_slug') || '';
  const key = c.req.param('key') || '';
  try {
    const removed = appMemory.del(ctx, slug, key);
    return c.json({ ok: true, removed });
  } catch (err) {
    return c.json(
      { error: (err as Error).message, code: 'memory_delete_failed' },
      500,
    );
  }
});

// ====================================================================
// Secrets
// ====================================================================

export const secretsRouter = new Hono();

const SecretSetBody = z.object({
  key: z.string().min(1).max(128),
  value: z.string().min(1),
});

/**
 * GET /api/secrets — list masked secret keys (never returns plaintext).
 */
secretsRouter.get('/', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  try {
    const entries = userSecrets.listMasked(ctx);
    return c.json({ entries });
  } catch (err) {
    return c.json(
      { error: (err as Error).message, code: 'secrets_list_failed' },
      500,
    );
  }
});

/**
 * POST /api/secrets — upsert a secret. Body: { key, value }. Response: {ok}.
 * The `value` field is NEVER echoed back.
 */
secretsRouter.post('/', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = SecretSetBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      400,
    );
  }
  try {
    userSecrets.set(ctx, parsed.data.key, parsed.data.value);
    return c.json({ ok: true, key: parsed.data.key });
  } catch (err) {
    if (err instanceof SecretDecryptError) {
      return c.json(
        { error: err.message, code: 'secret_encrypt_failed' },
        500,
      );
    }
    return c.json(
      { error: (err as Error).message, code: 'secret_set_failed' },
      500,
    );
  }
});

/**
 * DELETE /api/secrets/:key — remove a secret. Returns `{ ok, removed }`.
 */
secretsRouter.delete('/:key', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const key = c.req.param('key') || '';
  try {
    const removed = userSecrets.del(ctx, key);
    return c.json({ ok: true, removed });
  } catch (err) {
    return c.json(
      { error: (err as Error).message, code: 'secret_delete_failed' },
      500,
    );
  }
});
