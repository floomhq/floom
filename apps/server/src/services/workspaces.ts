// W3.1 workspaces service.
//
// Multi-user workspaces for Floom Cloud, also exposed in OSS so a single
// operator can rename their `local` workspace and exercise the same code
// paths Cloud uses. Five surfaces:
//
//   - CRUD (create / list / get / patch / delete)
//   - Members (list / change role / remove)
//   - Invites (create / list / accept / revoke)
//   - Active workspace switcher (used by /api/session/switch-workspace)
//   - me() — composed view consumed by /api/session/me
//
// Auth model (see services/session.ts): caller passes a SessionContext
// resolved from cookies. Every query is scoped by `ctx.workspace_id` for
// reads of workspace-owned data; cross-workspace operations (list-mine,
// create) are scoped by `ctx.user_id`. The local default user always has
// admin rights on the synthetic 'local' workspace so OSS keeps working.

import { randomBytes } from 'node:crypto';
import { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } from '../db.js';
import type {
  SessionContext,
  SessionMePayload,
  WorkspaceInviteRecord,
  WorkspaceMemberRecord,
  WorkspaceRecord,
  WorkspaceRole,
} from '../types.js';

// Default invite TTL = 14 days. Long enough that a user who gets the email
// on Friday can still accept on the following Sunday after vacation, short
// enough that stale invites don't pile up.
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const ROLES: WorkspaceRole[] = ['admin', 'editor', 'viewer'];

export class WorkspaceNotFoundError extends Error {
  constructor(workspace_id: string) {
    super(`workspace ${workspace_id} not found`);
    this.name = 'WorkspaceNotFoundError';
  }
}

export class NotAMemberError extends Error {
  constructor(user_id: string, workspace_id: string) {
    super(`user ${user_id} is not a member of workspace ${workspace_id}`);
    this.name = 'NotAMemberError';
  }
}

export class InsufficientRoleError extends Error {
  constructor(required: WorkspaceRole, actual: WorkspaceRole) {
    super(`requires ${required} role, caller has ${actual}`);
    this.name = 'InsufficientRoleError';
  }
}

export class InviteNotFoundError extends Error {
  constructor() {
    super('invite token not found or already used');
    this.name = 'InviteNotFoundError';
  }
}

export class InviteExpiredError extends Error {
  constructor() {
    super('invite has expired');
    this.name = 'InviteExpiredError';
  }
}

export class DuplicateMemberError extends Error {
  constructor() {
    super('user is already a member of this workspace');
    this.name = 'DuplicateMemberError';
  }
}

export class CannotRemoveLastAdminError extends Error {
  constructor() {
    super('cannot remove or demote the last admin of a workspace');
    this.name = 'CannotRemoveLastAdminError';
  }
}

function isValidRole(role: string): role is WorkspaceRole {
  return (ROLES as string[]).includes(role);
}

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function generateToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Look up a user's role in a workspace. Returns null if not a member.
 */
function getMemberRole(workspace_id: string, user_id: string): WorkspaceRole | null {
  const row = db
    .prepare(
      `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    )
    .get(workspace_id, user_id) as { role: string } | undefined;
  if (!row) return null;
  if (!isValidRole(row.role)) return 'viewer';
  return row.role;
}

/**
 * Throw if the caller is not at least the required role on the target
 * workspace. Local user always has admin on `local`.
 */
function assertRole(
  ctx: SessionContext,
  workspace_id: string,
  required: WorkspaceRole,
): WorkspaceRole {
  if (
    ctx.user_id === DEFAULT_USER_ID &&
    workspace_id === DEFAULT_WORKSPACE_ID
  ) {
    return 'admin';
  }
  const role = getMemberRole(workspace_id, ctx.user_id);
  if (!role) {
    throw new NotAMemberError(ctx.user_id, workspace_id);
  }
  // admin > editor > viewer
  const rank: Record<WorkspaceRole, number> = { admin: 3, editor: 2, viewer: 1 };
  if (rank[role] < rank[required]) {
    throw new InsufficientRoleError(required, role);
  }
  return role;
}

/**
 * Count active admins in a workspace. Used when removing a member or
 * demoting an admin to make sure we never strand a workspace.
 */
function countAdmins(workspace_id: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM workspace_members WHERE workspace_id = ? AND role = 'admin'`,
    )
    .get(workspace_id) as { c: number };
  return row.c;
}

/**
 * Resolve a slug to a unique value by appending a -<n> suffix if the base
 * slug is taken. Used by `create()` so two workspaces never share a slug.
 */
function uniqueSlug(base: string): string {
  const cleanBase = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
  let candidate = cleanBase;
  let n = 2;
  while (
    db.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(candidate)
  ) {
    candidate = `${cleanBase}-${n}`;
    n++;
  }
  return candidate;
}

// ====================================================================
// CRUD
// ====================================================================

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
}

/**
 * Create a workspace. The caller becomes its admin. Returns the new
 * workspace record. The active-workspace pointer for the caller is also
 * updated to the new workspace.
 */
export function create(
  ctx: SessionContext,
  input: CreateWorkspaceInput,
): WorkspaceRecord {
  const id = generateId('ws');
  const slug = uniqueSlug(input.slug || input.name);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, ?)`,
    ).run(id, slug, input.name, ctx.user_id === DEFAULT_USER_ID ? 'oss' : 'cloud_free');
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES (?, ?, 'admin')`,
    ).run(id, ctx.user_id);
    db.prepare(
      `INSERT INTO user_active_workspace (user_id, workspace_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (user_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         updated_at = excluded.updated_at`,
    ).run(ctx.user_id, id);
  });
  tx();
  const row = db
    .prepare('SELECT * FROM workspaces WHERE id = ?')
    .get(id) as WorkspaceRecord;
  return row;
}

/**
 * List the workspaces the caller is a member of. Always non-empty in OSS
 * (the synthetic local workspace is auto-joined for the local user).
 */
export function listMine(
  ctx: SessionContext,
): Array<{ workspace: WorkspaceRecord; role: WorkspaceRole }> {
  const rows = db
    .prepare(
      `SELECT w.id, w.slug, w.name, w.plan, w.wrapped_dek, w.created_at, m.role
         FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ?
        ORDER BY w.created_at ASC`,
    )
    .all(ctx.user_id) as Array<WorkspaceRecord & { role: string }>;
  return rows.map((r) => ({
    workspace: {
      id: r.id,
      slug: r.slug,
      name: r.name,
      plan: r.plan,
      wrapped_dek: r.wrapped_dek,
      created_at: r.created_at,
    },
    role: isValidRole(r.role) ? r.role : 'viewer',
  }));
}

/**
 * Fetch a workspace by id. Caller must be a member (any role). Throws
 * WorkspaceNotFoundError or NotAMemberError.
 */
export function getById(
  ctx: SessionContext,
  workspace_id: string,
): WorkspaceRecord {
  const row = db
    .prepare('SELECT * FROM workspaces WHERE id = ?')
    .get(workspace_id) as WorkspaceRecord | undefined;
  if (!row) throw new WorkspaceNotFoundError(workspace_id);
  // viewer is the lowest required role for a read.
  assertRole(ctx, workspace_id, 'viewer');
  return row;
}

/**
 * Update name/slug on an existing workspace. Admin-only.
 */
export function update(
  ctx: SessionContext,
  workspace_id: string,
  input: UpdateWorkspaceInput,
): WorkspaceRecord {
  assertRole(ctx, workspace_id, 'admin');
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    params.push(input.name);
  }
  if (input.slug !== undefined) {
    const newSlug = uniqueSlug(input.slug);
    sets.push('slug = ?');
    params.push(newSlug);
  }
  if (sets.length === 0) return getById(ctx, workspace_id);
  params.push(workspace_id);
  db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db
    .prepare('SELECT * FROM workspaces WHERE id = ?')
    .get(workspace_id) as WorkspaceRecord;
}

/**
 * Delete a workspace. Admin-only. The CASCADE wiring on workspace_members,
 * app_memory, user_secrets, runs, etc. handles cleanup. Refuses to delete
 * the synthetic 'local' workspace (would brick the OSS install).
 */
export function remove(ctx: SessionContext, workspace_id: string): void {
  if (workspace_id === DEFAULT_WORKSPACE_ID) {
    throw new Error('cannot delete the synthetic local workspace');
  }
  assertRole(ctx, workspace_id, 'admin');
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace_id);
  db.prepare('DELETE FROM user_active_workspace WHERE workspace_id = ?').run(
    workspace_id,
  );
}

// ====================================================================
// Members
// ====================================================================

export interface MemberWithUser extends WorkspaceMemberRecord {
  email: string | null;
  name: string | null;
}

/**
 * List members of a workspace. Caller must be a member.
 */
export function listMembers(
  ctx: SessionContext,
  workspace_id: string,
): MemberWithUser[] {
  assertRole(ctx, workspace_id, 'viewer');
  const rows = db
    .prepare(
      `SELECT m.workspace_id, m.user_id, m.role, m.joined_at, u.email, u.name
         FROM workspace_members m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ?
        ORDER BY m.joined_at ASC`,
    )
    .all(workspace_id) as MemberWithUser[];
  return rows.map((r) => ({
    workspace_id: r.workspace_id,
    user_id: r.user_id,
    role: isValidRole(r.role) ? r.role : 'viewer',
    joined_at: r.joined_at,
    email: r.email,
    name: r.name,
  }));
}

/**
 * Change a member's role. Admin-only. Refuses to demote the last admin.
 */
export function changeRole(
  ctx: SessionContext,
  workspace_id: string,
  target_user_id: string,
  new_role: WorkspaceRole,
): MemberWithUser {
  assertRole(ctx, workspace_id, 'admin');
  if (!isValidRole(new_role)) {
    throw new Error(`invalid role: ${new_role}`);
  }
  const current = getMemberRole(workspace_id, target_user_id);
  if (!current) {
    throw new NotAMemberError(target_user_id, workspace_id);
  }
  if (current === 'admin' && new_role !== 'admin' && countAdmins(workspace_id) <= 1) {
    throw new CannotRemoveLastAdminError();
  }
  db.prepare(
    `UPDATE workspace_members SET role = ?
       WHERE workspace_id = ? AND user_id = ?`,
  ).run(new_role, workspace_id, target_user_id);
  const after = listMembers(ctx, workspace_id).find(
    (m) => m.user_id === target_user_id,
  );
  if (!after) throw new NotAMemberError(target_user_id, workspace_id);
  return after;
}

/**
 * Remove a member from a workspace. Admin-only. Refuses to remove the
 * last admin. Removes the user's active-workspace pointer if it pointed
 * here.
 */
export function removeMember(
  ctx: SessionContext,
  workspace_id: string,
  target_user_id: string,
): void {
  assertRole(ctx, workspace_id, 'admin');
  const current = getMemberRole(workspace_id, target_user_id);
  if (!current) {
    throw new NotAMemberError(target_user_id, workspace_id);
  }
  if (current === 'admin' && countAdmins(workspace_id) <= 1) {
    throw new CannotRemoveLastAdminError();
  }
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    ).run(workspace_id, target_user_id);
    db.prepare(
      `DELETE FROM user_active_workspace WHERE user_id = ? AND workspace_id = ?`,
    ).run(target_user_id, workspace_id);
  });
  tx();
}

// ====================================================================
// Invites
// ====================================================================

export interface InviteResult {
  invite: WorkspaceInviteRecord;
  /**
   * The accept URL the inviter should forward to the invitee. Built from
   * the BETTER_AUTH_URL / PUBLIC_URL env so cloud + OSS produce the right
   * absolute link. Tests verify this is a string starting with http.
   */
  accept_url: string;
}

function publicBaseUrl(): string {
  return (
    process.env.BETTER_AUTH_URL ||
    process.env.PUBLIC_URL ||
    `http://localhost:${process.env.PORT || 3051}`
  );
}

/**
 * Create a pending invite. Admin-only. The email is normalized to lowercase
 * for de-duplication. Returns the invite + the accept URL the caller
 * should forward to the invitee.
 *
 * If the email already belongs to a member, throws DuplicateMemberError.
 */
export function inviteByEmail(
  ctx: SessionContext,
  workspace_id: string,
  email: string,
  role: WorkspaceRole = 'editor',
): InviteResult {
  assertRole(ctx, workspace_id, 'admin');
  if (!isValidRole(role)) {
    throw new Error(`invalid role: ${role}`);
  }
  const normalized = email.toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error(`invalid email: ${email}`);
  }
  // Reject if a current member already uses that email.
  const existingMember = db
    .prepare(
      `SELECT m.user_id FROM workspace_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND u.email = ?`,
    )
    .get(workspace_id, normalized);
  if (existingMember) throw new DuplicateMemberError();

  // Drop any prior pending invite for the same email+workspace so the
  // invitee always uses the freshest token.
  db.prepare(
    `DELETE FROM workspace_invites
       WHERE workspace_id = ? AND email = ? AND status = 'pending'`,
  ).run(workspace_id, normalized);

  const id = generateId('inv');
  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO workspace_invites
       (id, workspace_id, email, role, invited_by_user_id, token, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, workspace_id, normalized, role, ctx.user_id, token, expiresAt);

  const invite = db
    .prepare('SELECT * FROM workspace_invites WHERE id = ?')
    .get(id) as WorkspaceInviteRecord;
  const accept_url = `${publicBaseUrl()}/invite/${token}`;
  return { invite, accept_url };
}

/**
 * Accept a pending invite. The caller must be authenticated with an email
 * that matches the invite. On success, the user becomes a member at the
 * invited role, the invite is marked accepted, and the user's active
 * workspace points at the new one.
 */
export function acceptInvite(
  ctx: SessionContext,
  token: string,
): WorkspaceMemberRecord {
  if (!ctx.is_authenticated && ctx.user_id === DEFAULT_USER_ID) {
    throw new Error('must be authenticated to accept an invite');
  }
  const invite = db
    .prepare(
      `SELECT * FROM workspace_invites WHERE token = ? AND status = 'pending'`,
    )
    .get(token) as WorkspaceInviteRecord | undefined;
  if (!invite) throw new InviteNotFoundError();
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    db.prepare(
      `UPDATE workspace_invites SET status = 'expired' WHERE id = ?`,
    ).run(invite.id);
    throw new InviteExpiredError();
  }
  const user = db
    .prepare('SELECT email FROM users WHERE id = ?')
    .get(ctx.user_id) as { email: string | null } | undefined;
  if (!user || !user.email) {
    throw new Error('caller user has no email — cannot match invite');
  }
  if (user.email.toLowerCase() !== invite.email) {
    throw new InviteNotFoundError();
  }
  const role = isValidRole(invite.role) ? invite.role : 'editor';
  const tx = db.transaction(() => {
    // Already a member? Just promote / no-op.
    const existing = getMemberRole(invite.workspace_id, ctx.user_id);
    if (existing) {
      // No-op on existing membership; the invite still gets accepted so
      // it isn't reused.
    } else {
      db.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES (?, ?, ?)`,
      ).run(invite.workspace_id, ctx.user_id, role);
    }
    db.prepare(
      `UPDATE workspace_invites SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?`,
    ).run(invite.id);
    db.prepare(
      `INSERT INTO user_active_workspace (user_id, workspace_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (user_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         updated_at = excluded.updated_at`,
    ).run(ctx.user_id, invite.workspace_id);
  });
  tx();
  const after = db
    .prepare(
      `SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    )
    .get(invite.workspace_id, ctx.user_id) as WorkspaceMemberRecord;
  return after;
}

/**
 * List pending invites for a workspace. Admin-only. Used by the dashboard
 * to show "this person has been invited but hasn't accepted yet".
 */
export function listInvites(
  ctx: SessionContext,
  workspace_id: string,
): WorkspaceInviteRecord[] {
  assertRole(ctx, workspace_id, 'admin');
  return db
    .prepare(
      `SELECT * FROM workspace_invites
         WHERE workspace_id = ?
         ORDER BY created_at DESC`,
    )
    .all(workspace_id) as WorkspaceInviteRecord[];
}

/**
 * Revoke a pending invite. Admin-only.
 */
export function revokeInvite(
  ctx: SessionContext,
  workspace_id: string,
  invite_id: string,
): void {
  assertRole(ctx, workspace_id, 'admin');
  db.prepare(
    `UPDATE workspace_invites SET status = 'revoked'
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
  ).run(invite_id, workspace_id);
}

// ====================================================================
// Active workspace + me()
// ====================================================================

/**
 * Read the current active workspace for a user. Returns null if the user
 * has no rows (first request after login). Always returns 'local' for
 * the synthetic local user in OSS.
 */
export function getActiveWorkspaceId(user_id: string): string | null {
  if (user_id === DEFAULT_USER_ID) return DEFAULT_WORKSPACE_ID;
  const row = db
    .prepare('SELECT workspace_id FROM user_active_workspace WHERE user_id = ?')
    .get(user_id) as { workspace_id: string } | undefined;
  return row?.workspace_id || null;
}

/**
 * Switch the user's active workspace. Caller must be a member.
 */
export function switchActiveWorkspace(
  ctx: SessionContext,
  workspace_id: string,
): void {
  assertRole(ctx, workspace_id, 'viewer');
  db.prepare(
    `INSERT INTO user_active_workspace (user_id, workspace_id, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT (user_id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       updated_at = excluded.updated_at`,
  ).run(ctx.user_id, workspace_id);
}

/**
 * Compose the /api/session/me payload. Pure read — does NOT mutate state.
 * Returns the active workspace + role + the full list of memberships +
 * the cloud-mode flag for the UI to know whether to show the auth UI.
 */
export function me(ctx: SessionContext, cloud_mode: boolean): SessionMePayload {
  const memberships = listMine(ctx);
  // Pick the active workspace: explicit user_active_workspace row, or
  // the first membership, or fall back to local.
  const activeId =
    getActiveWorkspaceId(ctx.user_id) ||
    memberships[0]?.workspace.id ||
    DEFAULT_WORKSPACE_ID;
  const active = memberships.find((m) => m.workspace.id === activeId) || {
    workspace: db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(DEFAULT_WORKSPACE_ID) as WorkspaceRecord,
    role: 'admin' as WorkspaceRole,
  };
  const userRow = db
    .prepare('SELECT id, email, name FROM users WHERE id = ?')
    .get(ctx.user_id) as { id: string; email: string | null; name: string | null } | undefined;
  // W4-minimal gap close: in cloud mode, Better Auth's `user` table is the
  // source of truth for display name + avatar image. Profile updates flow
  // through /auth/update-user which writes to that table, not the Floom
  // `users` table. We do a lazy read-through here so /api/session/me
  // reflects the latest values without dual-writing on every mutation.
  // In OSS mode the Better Auth table may not exist; guard with a
  // try/catch so the query failure is a silent no-op.
  let betterAuthUser:
    | { name: string | null; image: string | null; email: string | null }
    | undefined;
  if (cloud_mode && ctx.user_id !== DEFAULT_USER_ID) {
    try {
      betterAuthUser = db
        .prepare('SELECT name, image, email FROM user WHERE id = ?')
        .get(ctx.user_id) as
        | { name: string | null; image: string | null; email: string | null }
        | undefined;
    } catch {
      betterAuthUser = undefined;
    }
  }
  return {
    user: {
      id: ctx.user_id,
      email: betterAuthUser?.email || userRow?.email || ctx.email || null,
      name: betterAuthUser?.name || userRow?.name || null,
      image: betterAuthUser?.image || null,
      is_local: ctx.user_id === DEFAULT_USER_ID,
    },
    active_workspace: {
      id: active.workspace.id,
      slug: active.workspace.slug,
      name: active.workspace.name,
      role: active.role,
    },
    workspaces: memberships.map((m) => ({
      id: m.workspace.id,
      slug: m.workspace.slug,
      name: m.workspace.name,
      role: m.role,
    })),
    cloud_mode,
    // Gate OAuth buttons on the client. A provider is enabled iff both
    // env vars are set on the server. In OSS mode we still return both
    // as false rather than omitting the object, so the UI can render a
    // stable shape.
    auth_providers: {
      google: Boolean(
        cloud_mode &&
          process.env.GOOGLE_OAUTH_CLIENT_ID &&
          process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      ),
      github: Boolean(
        cloud_mode &&
          process.env.GITHUB_OAUTH_CLIENT_ID &&
          process.env.GITHUB_OAUTH_CLIENT_SECRET,
      ),
    },
  };
}

/**
 * Create a personal workspace for a freshly-signed-up user. Used when a
 * user logs in via Better Auth and has no existing memberships. Picks a
 * slug derived from the email local-part. Idempotent: if the user already
 * has a workspace membership, we just ensure one is set as active and
 * return its id.
 */
export function provisionPersonalWorkspace(
  user_id: string,
  email: string,
  name?: string | null,
): string {
  const existing = db
    .prepare(
      `SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1`,
    )
    .get(user_id) as { workspace_id: string } | undefined;

  if (existing) {
    db.prepare(
      `INSERT INTO user_active_workspace (user_id, workspace_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (user_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         updated_at = excluded.updated_at`,
    ).run(user_id, existing.workspace_id);
    return existing.workspace_id;
  }

  const localPart = email.split('@')[0] || 'user';
  const workspaceName = name
    ? `${name.toLowerCase()}'s workspace`
    : `${localPart.toLowerCase()}'s workspace`;
  const baseSlug = localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'user';

  const slug = uniqueSlug(baseSlug);
  const id = generateId('ws');

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'cloud_free')`,
    ).run(id, slug, workspaceName);
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'admin')`,
    ).run(id, user_id);
    db.prepare(
      `INSERT INTO user_active_workspace (user_id, workspace_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (user_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         updated_at = excluded.updated_at`,
    ).run(user_id, id);
  });
  tx();
  return id;
}
