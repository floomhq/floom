// /api/me/apps/:slug/... — creator surface for per-app config.
//
// Today this module owns the secrets policy surface (secrets-policy
// feature). Two domains live here:
//
//   GET  /api/me/apps/:slug/secret-policies
//     Creator-only. Returns one row per key in the app's
//     `manifest.secrets_needed`, with the current policy
//     ('user_vault' or 'creator_override') and a boolean telling the
//     creator whether they already have a value stored (without
//     leaking the value itself).
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
//   DELETE /api/me/apps/:slug
//     Creator-only. Removes the app row (hard-delete; cascades per db.ts).
//     Non-owners and unknown slugs both receive 404 so callers cannot
//     probe for app existence.
//
// All routes require an authenticated caller in cloud mode. In OSS
// mode the synthetic local user is automatically the creator of every
// locally-seeded app, so the ownership check passes naturally.
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db.js';
import { deleteAppRecordById } from '../services/app_delete.js';
import { auditLog, getAuditActor } from '../services/audit-log.js';
import { resolveUserContext } from '../services/session.js';
import * as creatorSecrets from '../services/app_creator_secrets.js';
import { SecretDecryptError } from '../services/user_secrets.js';
import { checkAppVisibility, requireAuthenticatedInCloud } from '../lib/auth.js';
import { sendEmail, renderAppInviteEmail } from '../lib/email.js';
import { invalidateHubCache } from '../lib/hub-cache.js';
import {
  canonicalVisibility,
  findUserByEmail,
  findUserByUsername,
  isAppOwner,
  listInvites,
  transitionVisibility,
  upsertInvite,
  revokeInvite,
} from '../services/sharing.js';
import type {
  AppRecord,
  AppVisibilityState,
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

function serializeInvite(invite: ReturnType<typeof listInvites>[number]) {
  return {
    id: invite.id,
    invited_user_id: invite.invited_user_id,
    invited_email: invite.invited_email,
    state: invite.state,
    created_at: invite.created_at,
    accepted_at: invite.accepted_at,
    revoked_at: invite.revoked_at,
    invited_by_user_id: invite.invited_by_user_id,
    invited_user_name: invite.invited_user_name ?? null,
    invited_user_email: invite.invited_user_email ?? null,
  };
}

function publicUrl(): string {
  return (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3051}`).replace(/\/+$/, '');
}

const SharingPatchBody = z.object({
  state: z.enum(['private', 'link', 'invited']),
  comment: z.string().max(5000).optional(),
  link_token_rotate: z.boolean().optional(),
});

meAppsRouter.get('/:slug/sharing', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const app = loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (!isAppOwner(app, ctx)) return c.json({ error: 'App not found', code: 'not_found' }, 404);

  return c.json({
    slug: app.slug,
    visibility: canonicalVisibility(app.visibility),
    link_share_token: canonicalVisibility(app.visibility) === 'link' ? app.link_share_token : null,
    invites: listInvites(app.id).map(serializeInvite),
    review: {
      submitted_at: app.review_submitted_at,
      decided_at: app.review_decided_at,
      decided_by: app.review_decided_by,
      comment: app.review_comment,
    },
  });
});

meAppsRouter.patch('/:slug/sharing', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const app = loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (!isAppOwner(app, ctx)) return c.json({ error: 'App not found', code: 'not_found' }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = SharingPatchBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const to = parsed.data.state as AppVisibilityState;
  const current = canonicalVisibility(app.visibility);
  if (current === to && !(to === 'link' && parsed.data.link_token_rotate)) {
    return c.json({ ok: true, slug: app.slug, visibility: current, link_share_token: app.link_share_token });
  }

  let nextApp: AppRecord;
  try {
    nextApp = transitionVisibility(app, to, {
      actorUserId: ctx.user_id,
      actorTokenId: ctx.agent_token_id,
      actorIp: getAuditActor(c, ctx).ip,
      reason:
        to === 'private'
          ? current === 'public_live'
            ? 'owner_unlist'
            : 'owner_set_private'
          : to === 'link'
            ? 'owner_enable_link'
            : 'owner_set_invited',
      rotateLinkToken: parsed.data.link_token_rotate,
      metadata: parsed.data.comment ? { comment: parsed.data.comment } : undefined,
    });
  } catch {
    return c.json({ error: 'Illegal visibility transition', code: 'illegal_transition' }, 409);
  }
  invalidateHubCache();
  return c.json({
    ok: true,
    slug: nextApp.slug,
    visibility: canonicalVisibility(nextApp.visibility),
    link_share_token: canonicalVisibility(nextApp.visibility) === 'link' ? nextApp.link_share_token : null,
  });
});

const InviteBody = z
  .object({
    username: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
  })
  .refine((body) => Boolean(body.username) !== Boolean(body.email), {
    message: 'Provide exactly one of username or email',
  });

meAppsRouter.get('/:slug/sharing/user-search', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const app = loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (!isAppOwner(app, ctx)) return c.json({ error: 'App not found', code: 'not_found' }, 404);

  const q = (c.req.query('q') || '').trim().toLowerCase();
  if (q.length < 2) return c.json({ users: [] });
  const users = db
    .prepare(
      `SELECT id, email, name
         FROM users
        WHERE LOWER(COALESCE(name, '')) LIKE ?
           OR LOWER(COALESCE(email, '')) LIKE ?
        ORDER BY name, email
        LIMIT 10`,
    )
    .all(`%${q}%`, `%${q}%`) as Array<{ id: string; email: string | null; name: string | null }>;
  return c.json({ users });
});

meAppsRouter.post('/:slug/sharing/invite', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const app = loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (!isAppOwner(app, ctx)) return c.json({ error: 'App not found', code: 'not_found' }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = InviteBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  let invite;
  if (parsed.data.username) {
    const user = findUserByUsername(parsed.data.username);
    if (!user) return c.json({ error: 'User not found', code: 'user_not_found' }, 404);
    invite = upsertInvite({
      appId: app.id,
      invitedByUserId: ctx.user_id,
      invitedUserId: user.id,
      invitedEmail: user.email,
      state: 'pending_accept',
    });
  } else {
    const email = parsed.data.email!.trim().toLowerCase();
    const user = findUserByEmail(email);
    invite = upsertInvite({
      appId: app.id,
      invitedByUserId: ctx.user_id,
      invitedUserId: user?.id || null,
      invitedEmail: email,
      state: user ? 'pending_accept' : 'pending_email',
    });
    if (!user) {
      const inviter = db.prepare(`SELECT name, email FROM users WHERE id = ?`).get(ctx.user_id) as
        | { name: string | null; email: string | null }
        | undefined;
      const rendered = renderAppInviteEmail({
        appName: app.name,
        inviterName: inviter?.name || inviter?.email || null,
        acceptUrl: `${publicUrl()}/login?invite_id=${encodeURIComponent(invite.id)}`,
      });
      await sendEmail({ to: email, ...rendered });
    }
  }

  if (canonicalVisibility(app.visibility) === 'private') {
    try {
      transitionVisibility(app, 'invited', {
        actorUserId: ctx.user_id,
        actorTokenId: ctx.agent_token_id,
        actorIp: getAuditActor(c, ctx).ip,
        reason: 'owner_set_invited',
        metadata: { invite_id: invite.id },
      });
      invalidateHubCache();
    } catch {
      // Existing review/public states keep their current visibility; the invite
      // remains available if the owner later switches to invited.
    }
  }

  return c.json({ ok: true, invite: serializeInvite(invite) }, 201);
});

meAppsRouter.post('/:slug/sharing/invite/:invite_id/revoke', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const app = loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (!isAppOwner(app, ctx)) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  const invite = revokeInvite(c.req.param('invite_id') || '', app.id);
  if (!invite) return c.json({ error: 'Invite not found', code: 'not_found' }, 404);
  return c.json({ ok: true, invite: serializeInvite(invite) });
});

meAppsRouter.post('/:slug/sharing/submit-review', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const app = loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (!isAppOwner(app, ctx)) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  try {
    const next = transitionVisibility(app, 'pending_review', {
      actorUserId: ctx.user_id,
      actorTokenId: ctx.agent_token_id,
      actorIp: getAuditActor(c, ctx).ip,
      reason: canonicalVisibility(app.visibility) === 'changes_requested' ? 'owner_resubmit_review' : 'owner_submit_review',
    });
    invalidateHubCache();
    return c.json({ ok: true, slug: next.slug, visibility: canonicalVisibility(next.visibility) });
  } catch {
    return c.json({ error: 'Illegal visibility transition', code: 'illegal_transition' }, 409);
  }
});

meAppsRouter.post('/:slug/sharing/withdraw-review', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const app = loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (!isAppOwner(app, ctx)) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  try {
    const next = transitionVisibility(app, 'private', {
      actorUserId: ctx.user_id,
      actorTokenId: ctx.agent_token_id,
      actorIp: getAuditActor(c, ctx).ip,
      reason: 'owner_withdraw_review',
    });
    invalidateHubCache();
    return c.json({ ok: true, slug: next.slug, visibility: canonicalVisibility(next.visibility) });
  } catch {
    return c.json({ error: 'Illegal visibility transition', code: 'illegal_transition' }, 409);
  }
});

/**
 * GET /api/me/apps/:slug/secret-policies
 *
 * Returns `{ policies: SecretPolicyEntry[] }`. One entry per key in
 * `manifest.secrets_needed`, with default `policy='user_vault'` filled
 * in for keys that have no explicit row. `creator_has_value` is
 * populated from app_creator_secrets (presence only; no plaintext).
 * Creator-only: non-owners must not learn which keys are overridden or
 * already configured on the creator's account.
 */
meAppsRouter.get('/:slug/secret-policies', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const slug = c.req.param('slug') || '';
  const app = loadApp(slug);
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  const blocked = checkAppVisibility(c, app.visibility || 'public', {
    app_id: app.id,
    author: app.author,
    workspace_id: app.workspace_id,
    link_share_token: app.link_share_token,
    ctx,
  });
  if (blocked) return blocked;
  if (!isOwner(app, ctx)) {
    return c.json(
      { error: 'Not the owner of this app', code: 'not_owner' },
      403,
    );
  }

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
    const previousPolicy = creatorSecrets.getPolicy(app.id, key);
    creatorSecrets.setPolicy(app.id, key, parsed.data.policy as SecretPolicy);
    auditLog({
      actor: getAuditActor(c, ctx),
      action: 'secret.policy_updated',
      target: { type: 'secret', id: `${app.id}:${key}` },
      before: { policy: previousPolicy },
      after: { policy: parsed.data.policy },
      metadata: {
        app_id: app.id,
        slug: app.slug,
        key,
        workspace_id: app.workspace_id || ctx.workspace_id,
      },
    });
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
    const existed = creatorSecrets.hasCreatorValue(app.id, key);
    creatorSecrets.setCreatorSecret(
      app.id,
      app.workspace_id || ctx.workspace_id,
      key,
      parsed.data.value,
    );
    auditLog({
      actor: getAuditActor(c, ctx),
      action: 'secret.updated',
      target: { type: 'secret', id: `${app.id}:${key}` },
      before: { exists: existed },
      after: { exists: true },
      metadata: {
        app_id: app.id,
        slug: app.slug,
        key,
        workspace_id: app.workspace_id || ctx.workspace_id,
        scope: 'creator_override',
      },
    });
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
    const existed = creatorSecrets.hasCreatorValue(app.id, key);
    const removed = creatorSecrets.deleteCreatorSecret(app.id, key);
    auditLog({
      actor: getAuditActor(c, ctx),
      action: 'secret.deleted',
      target: { type: 'secret', id: `${app.id}:${key}` },
      before: { exists: existed },
      after: { exists: existed && !removed },
      metadata: {
        app_id: app.id,
        slug: app.slug,
        key,
        workspace_id: app.workspace_id || ctx.workspace_id,
        scope: 'creator_override',
        removed,
      },
    });
    return c.json({ ok: true, removed });
  } catch (err) {
    return c.json(
      { error: (err as Error).message, code: 'creator_secret_delete_failed' },
      500,
    );
  }
});

/**
 * DELETE /api/me/apps/:slug — delete the entire app (Studio + manage-my-apps).
 *
 * Ownership matches other routes here (`isOwner`, including the OSS
 * local escape hatch). Missing slug or non-owner: same 404 as each other
 * so the response does not reveal whether a slug is registered.
 */
meAppsRouter.delete('/:slug', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;

  const slug = c.req.param('slug') || '';
  const app = loadApp(slug);
  if (!app || !isOwner(app, ctx)) {
    return c.json({ error: 'App not found', code: 'not_found' }, 404);
  }

  try {
    auditLog({
      actor: getAuditActor(c, ctx),
      action: 'app.deleted',
      target: { type: 'app', id: app.id },
      before: {
        slug: app.slug,
        visibility: app.visibility,
        publish_status: app.publish_status,
        workspace_id: app.workspace_id,
        author: app.author,
      },
      after: null,
      metadata: { slug: app.slug },
    });
    deleteAppRecordById(app.id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json(
      { error: (err as Error).message, code: 'app_delete_failed' },
      500,
    );
  }
});
