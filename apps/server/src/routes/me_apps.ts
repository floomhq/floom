// /api/me/apps/:slug/... — creator + viewer surface for per-app config.
//
// Today this module owns the secrets policy surface (secrets-policy
// feature). Two domains live here:
//
//   GET  /api/me/apps/:slug/secret-policies
//     Available to any logged-in viewer. Returns one row per key in
//     the app's `manifest.secrets_needed`, with the current policy
//     ('user_vault' or 'creator_override') and a boolean telling the
//     caller whether the creator has a value stored (without leaking
//     the value itself).
//
//   PUT  /api/me/apps/:slug/secret-policies/:key
//     Creator-only. Flips the policy for one key between 'user_vault'
//     and 'creator_override'. Changing creator_override → user_vault
//     does NOT delete the stored value so the creator can flip back
//     without re-entering it.
//
//   PUT  /api/me/apps/:slug/creator-secrets/:key
//   DELETE /api/me/apps/:slug/creator-secrets/:key
//     Creator-only. Upsert / delete the creator-owned plaintext value
//     for a key whose policy is 'creator_override'. Plaintext is
//     AES-256-GCM encrypted under the creator's workspace DEK via the
//     same envelope scheme that user_secrets uses.
//
// All routes require an authenticated caller in cloud mode. In OSS
// mode the synthetic local user is automatically the creator of every
// locally-seeded app, so the ownership check passes naturally.
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db.js';
import { resolveUserContext } from '../services/session.js';
import * as creatorSecrets from '../services/app_creator_secrets.js';
import { SecretDecryptError } from '../services/user_secrets.js';
import { requireAuthenticatedInCloud } from '../lib/auth.js';
import type {
  AppRecord,
  NormalizedManifest,
  SecretPolicy,
  SecretPolicyEntry,
} from '../types.js';

export const meAppsRouter = new Hono();

function safeManifest(raw: string): NormalizedManifest | null {
  try {
    return JSON.parse(raw) as NormalizedManifest;
  } catch {
    return null;
  }
}

function loadApp(slug: string): AppRecord | undefined {
  return db
    .prepare('SELECT * FROM apps WHERE slug = ?')
    .get(slug) as AppRecord | undefined;
}

function isOwner(
  app: AppRecord,
  ctx: { user_id: string; workspace_id: string; is_authenticated: boolean },
): boolean {
  if (app.author && app.author === ctx.user_id) return true;
  // OSS solo mode: the local user is the creator of every locally-seeded
  // app whose workspace is the synthetic 'local' workspace, even when
  // `author` is NULL on the row.
  const isOssLocal = !ctx.is_authenticated && ctx.workspace_id === 'local';
  if (isOssLocal && (app.workspace_id === 'local' || !app.author)) {
    return true;
  }
  return false;
}

/**
 * GET /api/me/apps/:slug/secret-policies
 *
 * Returns `{ policies: SecretPolicyEntry[] }`. One entry per key in
 * `manifest.secrets_needed`, with default `policy='user_vault'` filled
 * in for keys that have no explicit row. `creator_has_value` is
 * populated from app_creator_secrets (presence only; no plaintext).
 */
meAppsRouter.get('/:slug/secret-policies', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const slug = c.req.param('slug') || '';
  const app = loadApp(slug);
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);

  const manifest = safeManifest(app.manifest);
  const neededKeys = manifest?.secrets_needed ?? [];

  const explicit = new Map<string, SecretPolicyEntry>(
    creatorSecrets.listPolicies(app.id).map((p) => [p.key, p]),
  );

  const policies: SecretPolicyEntry[] = neededKeys.map((key) => {
    const hit = explicit.get(key);
    if (hit) return hit;
    // Default: every needed key without a row is treated as user_vault.
    // creator_has_value stays false because no row in
    // app_creator_secrets should exist for a user_vault key (and even
    // if one did, the policy controls injection, not storage).
    return {
      key,
      policy: 'user_vault',
      creator_has_value: creatorSecrets.hasCreatorValue(app.id, key),
    };
  });

  return c.json({ policies });
});

const PolicyBody = z.object({
  policy: z.enum(['user_vault', 'creator_override']),
});

/**
 * PUT /api/me/apps/:slug/secret-policies/:key
 * Creator-only. Flip the policy between user_vault and creator_override.
 */
meAppsRouter.put('/:slug/secret-policies/:key', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const slug = c.req.param('slug') || '';
  const key = c.req.param('key') || '';
  const app = loadApp(slug);
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (!isOwner(app, ctx)) {
    return c.json(
      { error: 'Not the owner of this app', code: 'not_owner' },
      403,
    );
  }

  const manifest = safeManifest(app.manifest);
  const neededKeys = new Set(manifest?.secrets_needed ?? []);
  if (!neededKeys.has(key)) {
    return c.json(
      {
        error: `Key "${key}" is not declared in secrets_needed for this app`,
        code: 'unknown_secret_key',
      },
      400,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = PolicyBody.safeParse(body);
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
    creatorSecrets.setPolicy(app.id, key, parsed.data.policy as SecretPolicy);
    return c.json({ ok: true, policy: parsed.data.policy });
  } catch (err) {
    return c.json(
      { error: (err as Error).message, code: 'policy_set_failed' },
      500,
    );
  }
});

const CreatorSecretBody = z.object({
  // Same cap as /api/secrets (user vault). 1..65_536 chars covers every
  // real credential; the upper bound exists to stop accidental giant
  // pastes before the crypto layer even sees them.
  value: z.string().min(1).max(65536),
});

/**
 * PUT /api/me/apps/:slug/creator-secrets/:key — creator-only upsert.
 *
 * Rejects keys that are not currently under the 'creator_override'
 * policy so the creator can't accidentally stash a user-vault value
 * in the creator slot (which would be dormant and confusing).
 */
meAppsRouter.put('/:slug/creator-secrets/:key', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const slug = c.req.param('slug') || '';
  const key = c.req.param('key') || '';
  const app = loadApp(slug);
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (!isOwner(app, ctx)) {
    return c.json(
      { error: 'Not the owner of this app', code: 'not_owner' },
      403,
    );
  }

  const manifest = safeManifest(app.manifest);
  const neededKeys = new Set(manifest?.secrets_needed ?? []);
  if (!neededKeys.has(key)) {
    return c.json(
      {
        error: `Key "${key}" is not declared in secrets_needed for this app`,
        code: 'unknown_secret_key',
      },
      400,
    );
  }

  const policy = creatorSecrets.getPolicy(app.id, key);
  if (policy !== 'creator_override') {
    return c.json(
      {
        error:
          'Policy for this key is not creator_override. Flip the policy before storing a creator value.',
        code: 'policy_mismatch',
      },
      400,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = CreatorSecretBody.safeParse(body);
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
    creatorSecrets.setCreatorSecret(
      app.id,
      app.workspace_id || ctx.workspace_id,
      key,
      parsed.data.value,
    );
    return c.json({ ok: true, key });
  } catch (err) {
    if (err instanceof SecretDecryptError) {
      return c.json(
        { error: err.message, code: 'secret_encrypt_failed' },
        500,
      );
    }
    return c.json(
      { error: (err as Error).message, code: 'creator_secret_set_failed' },
      500,
    );
  }
});

/**
 * DELETE /api/me/apps/:slug/creator-secrets/:key — creator-only delete.
 */
meAppsRouter.delete('/:slug/creator-secrets/:key', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const slug = c.req.param('slug') || '';
  const key = c.req.param('key') || '';
  const app = loadApp(slug);
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (!isOwner(app, ctx)) {
    return c.json(
      { error: 'Not the owner of this app', code: 'not_owner' },
      403,
    );
  }

  try {
    const removed = creatorSecrets.deleteCreatorSecret(app.id, key);
    return c.json({ ok: true, removed });
  } catch (err) {
    return c.json(
      { error: (err as Error).message, code: 'creator_secret_delete_failed' },
      500,
    );
  }
});
