// W3.1 /api/workspaces routes.
//
// Owns workspace CRUD, member management, invitations, and the active-
// workspace switcher used by the dashboard sidebar. Mirrors the Composio
// connections route shape: every handler resolves a SessionContext via
// the W2.1 `resolveUserContext`, all errors return `{error, code, details?}`,
// no raw stack traces.
//
// Two surfaces:
//
//   - /api/workspaces                 (CRUD)
//   - /api/workspaces/:id/members     (list/role/remove)
//   - /api/workspaces/:id/members/invite + accept-invite + invites
//
// Plus a tiny session API:
//
//   - /api/session/me                 (composed user + workspace + role)
//   - /api/session/switch-workspace
//
// Auth model: in OSS mode every call goes through as the synthetic local
// user (the local user is admin on the synthetic 'local' workspace). In
// Cloud mode the SessionContext carries the real user + active workspace
// and `assertRole` enforces RBAC.

import { Hono } from 'hono';
import { z } from 'zod';
import { resolveUserContext } from '../services/session.js';
import * as ws from '../services/workspaces.js';
import {
  CannotRemoveLastAdminError,
  DuplicateMemberError,
  InsufficientRoleError,
  InviteExpiredError,
  InviteNotFoundError,
  NotAMemberError,
  WorkspaceNotFoundError,
} from '../services/workspaces.js';
import { isCloudMode } from '../lib/better-auth.js';
import { requireAuthenticatedInCloud } from '../lib/auth.js';
import type { WorkspaceMemberRole } from '../types.js';

export const workspacesRouter = new Hono();
export const sessionRouter = new Hono();

// --------------------------------------------------------------------
// Zod schemas
// --------------------------------------------------------------------

const RoleEnum = z.enum(['admin', 'editor', 'viewer']);

const CreateWorkspaceBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(64).optional(),
});

const UpdateWorkspaceBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: z.string().min(1).max(64).optional(),
  })
  .refine((v) => v.name !== undefined || v.slug !== undefined, {
    message: 'must include name or slug',
  });

const InviteBody = z.object({
  email: z.string().email().max(320),
  role: RoleEnum.optional().default('editor'),
});

const ChangeRoleBody = z.object({
  role: RoleEnum,
});

const AcceptInviteBody = z.object({
  token: z.string().min(8).max(128),
});

const SwitchWorkspaceBody = z.object({
  workspace_id: z.string().min(1).max(64),
});

// --------------------------------------------------------------------
// Error envelope helper
// --------------------------------------------------------------------

function mapError(err: unknown): { status: 400 | 401 | 403 | 404 | 409 | 500; body: { error: string; code: string; details?: unknown } } {
  if (err instanceof WorkspaceNotFoundError) {
    return { status: 404, body: { error: err.message, code: 'workspace_not_found' } };
  }
  if (err instanceof NotAMemberError) {
    return { status: 403, body: { error: err.message, code: 'not_a_member' } };
  }
  if (err instanceof InsufficientRoleError) {
    return { status: 403, body: { error: err.message, code: 'insufficient_role' } };
  }
  if (err instanceof InviteNotFoundError) {
    return { status: 404, body: { error: err.message, code: 'invite_not_found' } };
  }
  if (err instanceof InviteExpiredError) {
    return { status: 410 as unknown as 400, body: { error: err.message, code: 'invite_expired' } };
  }
  if (err instanceof DuplicateMemberError) {
    return { status: 409, body: { error: err.message, code: 'duplicate_member' } };
  }
  if (err instanceof CannotRemoveLastAdminError) {
    return { status: 409, body: { error: err.message, code: 'last_admin' } };
  }
  return {
    status: 500,
    body: {
      error: (err as Error).message || 'unknown error',
      code: 'workspace_error',
    },
  };
}

// --------------------------------------------------------------------
// Workspaces CRUD
// --------------------------------------------------------------------

/**
 * POST /api/workspaces
 * Body: { name, slug? }
 * Caller becomes admin of the newly created workspace.
 */
workspacesRouter.post('/', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = CreateWorkspaceBody.safeParse(body);
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
    const w = ws.create(ctx, parsed.data);
    return c.json({ workspace: w }, 201);
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

/**
 * GET /api/workspaces
 * Returns workspaces the caller is a member of, with their role on each.
 */
workspacesRouter.get('/', async (c) => {
  const ctx = await resolveUserContext(c);
  try {
    const rows = ws.listMine(ctx);
    return c.json({
      workspaces: rows.map((r) => ({
        ...r.workspace,
        role: r.role,
      })),
    });
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

/**
 * GET /api/workspaces/:id
 */
workspacesRouter.get('/:id', async (c) => {
  const ctx = await resolveUserContext(c);
  const id = c.req.param('id') || '';
  try {
    const w = ws.getById(ctx, id);
    return c.json({ workspace: w });
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

/**
 * PATCH /api/workspaces/:id
 * Body: { name?, slug? } — at least one required.
 * Admin-only.
 */
workspacesRouter.patch('/:id', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const id = c.req.param('id') || '';
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = UpdateWorkspaceBody.safeParse(body);
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
    const w = ws.update(ctx, id, parsed.data);
    return c.json({ workspace: w });
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

/**
 * DELETE /api/workspaces/:id
 * Admin-only. Refuses to delete the synthetic 'local' workspace.
 */
workspacesRouter.delete('/:id', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const id = c.req.param('id') || '';
  try {
    ws.remove(ctx, id);
    return c.json({ ok: true });
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

// --------------------------------------------------------------------
// Members
// --------------------------------------------------------------------

/**
 * GET /api/workspaces/:id/members
 */
workspacesRouter.get('/:id/members', async (c) => {
  const ctx = await resolveUserContext(c);
  const id = c.req.param('id') || '';
  try {
    const members = ws.listMembers(ctx, id);
    return c.json({ members });
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

/**
 * PATCH /api/workspaces/:id/members/:user_id
 * Body: { role: 'admin' | 'editor' | 'viewer' }
 * Admin-only. Refuses to demote the last admin.
 */
workspacesRouter.patch('/:id/members/:user_id', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const id = c.req.param('id') || '';
  const target = c.req.param('user_id') || '';
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = ChangeRoleBody.safeParse(body);
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
    const updated = ws.changeRole(ctx, id, target, parsed.data.role as WorkspaceMemberRole);
    return c.json({ member: updated });
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

/**
 * DELETE /api/workspaces/:id/members/:user_id
 * Admin-only. Refuses to remove the last admin.
 */
workspacesRouter.delete('/:id/members/:user_id', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const id = c.req.param('id') || '';
  const target = c.req.param('user_id') || '';
  try {
    ws.removeMember(ctx, id, target);
    return c.json({ ok: true });
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

// --------------------------------------------------------------------
// Invites
// --------------------------------------------------------------------

/**
 * POST /api/workspaces/:id/members/invite
 * Body: { email, role? }
 * Admin-only. Returns the invite + the accept URL the caller should
 * forward to the invitee.
 */
workspacesRouter.post('/:id/members/invite', async (c) => {
  const ctx = await resolveUserContext(c);
  const gate = requireAuthenticatedInCloud(c, ctx);
  if (gate) return gate;
  const id = c.req.param('id') || '';
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = InviteBody.safeParse(body);
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
    const result = ws.inviteByEmail(
      ctx,
      id,
      parsed.data.email,
      parsed.data.role as WorkspaceMemberRole,
    );
    return c.json(result, 201);
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

/**
 * GET /api/workspaces/:id/invites
 * Admin-only. Lists pending + historical invites for the workspace.
 */
workspacesRouter.get('/:id/invites', async (c) => {
  const ctx = await resolveUserContext(c);
  const id = c.req.param('id') || '';
  try {
    const invites = ws.listInvites(ctx, id);
    return c.json({ invites });
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

/**
 * DELETE /api/workspaces/:id/invites/:invite_id
 * Admin-only. Marks a pending invite as revoked.
 */
workspacesRouter.delete('/:id/invites/:invite_id', async (c) => {
  const ctx = await resolveUserContext(c);
  const id = c.req.param('id') || '';
  const inviteId = c.req.param('invite_id') || '';
  try {
    ws.revokeInvite(ctx, id, inviteId);
    return c.json({ ok: true });
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

/**
 * POST /api/workspaces/:id/members/accept-invite
 * Body: { token }
 * Caller must be authenticated with the email matching the invite. The
 * `:id` in the URL is informational; the token is the source of truth.
 */
workspacesRouter.post('/:id/members/accept-invite', async (c) => {
  const ctx = await resolveUserContext(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = AcceptInviteBody.safeParse(body);
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
    const member = ws.acceptInvite(ctx, parsed.data.token);
    return c.json({ member });
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

// --------------------------------------------------------------------
// Session router (mounted at /api/session)
// --------------------------------------------------------------------

/**
 * GET /api/session/me
 * Returns the current user, their active workspace, and all workspace
 * memberships. Always returns 200 — in OSS mode this is the synthetic
 * local user; in Cloud mode this is the Better Auth user.
 */
sessionRouter.get('/me', async (c) => {
  const ctx = await resolveUserContext(c);
  try {
    const payload = ws.me(ctx, isCloudMode());
    return c.json(payload);
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});

/**
 * POST /api/session/switch-workspace
 * Body: { workspace_id }
 * Sets the caller's active workspace pointer. Caller must be a member.
 */
sessionRouter.post('/switch-workspace', async (c) => {
  const ctx = await resolveUserContext(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = SwitchWorkspaceBody.safeParse(body);
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
    ws.switchActiveWorkspace(ctx, parsed.data.workspace_id);
    return c.json({ ok: true, active_workspace_id: parsed.data.workspace_id });
  } catch (err) {
    const m = mapError(err);
    return c.json(m.body, m.status);
  }
});
