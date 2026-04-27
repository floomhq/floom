// /api/me/triggers — caller's triggers list + per-id PATCH / DELETE.
// /api/hub/:slug/triggers — auth-owner-only create for a given app.
//
// This module owns the MANAGEMENT endpoints. The incoming webhook dispatch
// (POST /hook/:path) lives in routes/webhook.ts so it can be mounted at a
// root path without interfering with the /api namespace.
import { Hono } from 'hono';
import { z } from 'zod';
import { adapters } from '../adapters/index.js';
import { resolveUserContext } from '../services/session.js';
import { notOwnerResponse, requireAuthenticatedInCloud } from '../lib/auth.js';
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggersForUser,
  serializeTrigger,
  updateTrigger,
  validateCronExpression,
} from '../services/triggers.js';
import type { AppRecord, NormalizedManifest } from '../types.js';

export const meTriggersRouter = new Hono();
export const hubTriggersRouter = new Hono();

// ---------- Shared helpers ----------

const CreateTriggerBody = z
  .object({
    action: z.string().min(1).max(128),
    inputs: z.record(z.unknown()).optional(),
    trigger_type: z.enum(['schedule', 'webhook']),
    cron_expression: z.string().min(1).max(256).optional(),
    tz: z.string().min(1).max(64).optional(),
  })
  .refine(
    (data) => data.trigger_type !== 'schedule' || !!data.cron_expression,
    { message: 'cron_expression is required for schedule triggers' },
  );

function publicUrl(): string {
  return (
    process.env.PUBLIC_URL ||
    process.env.PUBLIC_ORIGIN ||
    `http://localhost:${process.env.PORT || 3051}`
  );
}

function buildWebhookUrl(path: string): string {
  return `${publicUrl()}/hook/${path}`;
}

function ownerOf(app: AppRecord, ctx: { user_id: string; workspace_id: string; is_authenticated: boolean }): boolean {
  const isOssLocal = !ctx.is_authenticated && ctx.workspace_id === 'local';
  if (app.author && app.author === ctx.user_id) return true;
  if (isOssLocal && app.workspace_id === 'local') return true;
  return false;
}

async function slugFor(appId: string): Promise<string | undefined> {
  const row = await adapters.storage.getAppById(appId);
  return row?.slug;
}

// ---------- POST /api/hub/:slug/triggers — create ----------

hubTriggersRouter.post('/:slug/triggers', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const slug = c.req.param('slug');
  const app = await adapters.storage.getApp(slug);
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (!ownerOf(app, ctx)) {
    return notOwnerResponse(c);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = CreateTriggerBody.safeParse(body);
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

  // Validate action exists on the manifest.
  let manifest: NormalizedManifest;
  try {
    manifest = JSON.parse(app.manifest);
  } catch {
    return c.json({ error: 'App manifest is corrupted', code: 'manifest_invalid' }, 500);
  }
  if (!manifest.actions[parsed.data.action]) {
    return c.json(
      {
        error: `Action "${parsed.data.action}" is not declared on this app`,
        code: 'invalid_action',
        valid_actions: Object.keys(manifest.actions),
      },
      400,
    );
  }

  // Early cron validation so the 400 reaches the UI before we INSERT.
  if (parsed.data.trigger_type === 'schedule') {
    const check = validateCronExpression(
      parsed.data.cron_expression as string,
      parsed.data.tz,
    );
    if (!check.ok) {
      return c.json(
        {
          error: `Invalid cron expression: ${check.error}`,
          code: 'invalid_cron',
        },
        400,
      );
    }
  }

  try {
    const trigger = await createTrigger({
      app_id: app.id,
      user_id: ctx.user_id,
      workspace_id: ctx.workspace_id,
      action: parsed.data.action,
      inputs: (parsed.data.inputs as Record<string, unknown>) || {},
      trigger_type: parsed.data.trigger_type,
      cron_expression: parsed.data.cron_expression || null,
      tz: parsed.data.tz || null,
    });

    const payload: Record<string, unknown> = {
      trigger: serializeTrigger(trigger, { app_slug: app.slug }),
    };
    // For webhook triggers the creator needs BOTH the URL AND the plaintext
    // secret, ONCE. GETs never return the secret (it's masked by
    // serializeTrigger). Losing the secret = delete + recreate the trigger.
    if (trigger.trigger_type === 'webhook') {
      payload.webhook_url = buildWebhookUrl(trigger.webhook_url_path || '');
      payload.webhook_secret = trigger.webhook_secret;
      payload.webhook_url_path = trigger.webhook_url_path;
    }
    return c.json(payload, 201);
  } catch (err) {
    return c.json(
      { error: (err as Error).message || 'create_failed', code: 'create_failed' },
      400,
    );
  }
});

// ---------- GET /api/me/triggers — list caller's triggers ----------

meTriggersRouter.get('/', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const rows = await listTriggersForUser(ctx.user_id);
  const triggers = await Promise.all(
    rows.map(async (r) =>
      serializeTrigger(r, { app_slug: await slugFor(r.app_id) }),
    ),
  );
  return c.json({
    triggers,
  });
});

// ---------- PATCH /api/me/triggers/:id — enable/disable/edit ----------

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  cron_expression: z.string().min(1).max(256).optional(),
  tz: z.string().min(1).max(64).optional(),
  inputs: z.record(z.unknown()).optional(),
  action: z.string().min(1).max(128).optional(),
});

meTriggersRouter.patch('/:id', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const id = c.req.param('id');
  const existing = await getTrigger(id);
  if (!existing) {
    return c.json({ error: 'Trigger not found', code: 'not_found' }, 404);
  }
  if (existing.user_id !== ctx.user_id) {
    return c.json(
      { error: 'Not the owner of this trigger', code: 'not_owner' },
      403,
    );
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
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  // If the caller is editing the action, validate it against the app manifest.
  if (parsed.data.action) {
    const app = await adapters.storage.getAppById(existing.app_id);
    if (!app) {
      return c.json({ error: 'App no longer exists', code: 'app_missing' }, 409);
    }
    let manifest: NormalizedManifest;
    try {
      manifest = JSON.parse(app.manifest);
    } catch {
      return c.json(
        { error: 'App manifest is corrupted', code: 'manifest_invalid' },
        500,
      );
    }
    if (!manifest.actions[parsed.data.action]) {
      return c.json(
        {
          error: `Action "${parsed.data.action}" is not declared on this app`,
          code: 'invalid_action',
          valid_actions: Object.keys(manifest.actions),
        },
        400,
      );
    }
  }

  try {
    const updated = await updateTrigger(id, parsed.data);
    if (!updated) {
      return c.json({ error: 'Trigger not found', code: 'not_found' }, 404);
    }
    return c.json({
      trigger: serializeTrigger(updated, { app_slug: await slugFor(updated.app_id) }),
    });
  } catch (err) {
    return c.json(
      { error: (err as Error).message || 'patch_failed', code: 'patch_failed' },
      400,
    );
  }
});

// ---------- DELETE /api/me/triggers/:id ----------

meTriggersRouter.delete('/:id', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const id = c.req.param('id');
  const existing = await getTrigger(id);
  if (!existing) {
    return c.json({ error: 'Trigger not found', code: 'not_found' }, 404);
  }
  if (existing.user_id !== ctx.user_id) {
    return c.json(
      { error: 'Not the owner of this trigger', code: 'not_owner' },
      403,
    );
  }
  await deleteTrigger(id);
  return c.json({ ok: true, id });
});
