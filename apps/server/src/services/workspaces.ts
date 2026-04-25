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
import { DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } from '../db.js';
import { storage } from './storage.js';
import type {
  SessionContext,
  SessionMePayload,
  WorkspaceInviteRecord,
  WorkspaceMemberRecord,
  WorkspaceMemberRole,
  WorkspaceRecord,
  WorkspaceRole,
} from '../types.js';

// Default invite TTL = 14 days. Long enough that a user who gets the email
// on Friday can still accept on the following Sunday after vacation, short
// enough that stale invites don't pile up.
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const ROLES: WorkspaceMemberRole[] = ['admin', 'editor', 'viewer'];

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
  constructor(required: WorkspaceMemberRole, actual: WorkspaceMemberRole) {
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

function isValidRole(role: string): role is WorkspaceMemberRole {
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
function getMemberRole(
  workspace_id: string,
  user_id: string,
): WorkspaceMemberRole | null {
  const role = storage.getMemberRole(workspace_id, user_id);
  if (!role) return null;
  if (!isValidRole(role)) return 'viewer';
  return role;
}

/**
 * Throw if the caller is not at least the required role on the target
 * workspace. Local user always has admin on `local`.
 */
function assertRole(
  ctx: SessionContext,
  workspace_id: string,
  required: WorkspaceMemberRole,
): WorkspaceMemberRole {
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
  const rank: Record<WorkspaceMemberRole, number> = {
    admin: 3,
    editor: 2,
    viewer: 1,
  };
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
  return storage.countWorkspaceAdmins(workspace_id);
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
  while (storage.getWorkspaceBySlug(candidate)) {
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
  return storage.createWorkspaceWithMember({
    workspace: {
      id,
      slug,
      name: input.name,
      plan: ctx.user_id === DEFAULT_USER_ID ? 'oss' : 'cloud_free',
    },
    user_id: ctx.user_id,
    role: 'admin',
  });
}

/**
 * List the workspaces the caller is a member of. Always non-empty in OSS
 * (the synthetic local workspace is auto-joined for the local user).
 */
export function listMine(
  ctx: SessionContext,
): Array<{ workspace: WorkspaceRecord; role: WorkspaceRole }> {
  const rows = storage.listWorkspacesForUser(ctx.user_id);
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
  const row = storage.getWorkspace(workspace_id);
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
  const patch: { name?: string; slug?: string } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.slug !== undefined) patch.slug = uniqueSlug(input.slug);
  
  const updated = storage.updateWorkspace(workspace_id, patch);
  if (!updated) throw new WorkspaceNotFoundError(workspace_id);
  return updated;
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
  storage.deleteWorkspace(workspace_id);
  storage.deleteActiveWorkspaceForWorkspace(workspace_id);
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
  const rows = storage.listWorkspaceMembers(workspace_id);
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
  new_role: WorkspaceMemberRole,
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
  storage.upsertWorkspaceMember(workspace_id, target_user_id, new_role);
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
  storage.removeWorkspaceMember(workspace_id, target_user_id);
  storage.deleteActiveWorkspaceForUserAndWorkspace(target_user_id, workspace_id);
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
  role: WorkspaceMemberRole = 'editor',
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
  const members = storage.listWorkspaceMembers(workspace_id);
  const existingMember = members.find(m => m.email === normalized);
  if (existingMember) throw new DuplicateMemberError();

  // Drop any prior pending invite for the same email+workspace so the
  // invitee always uses the freshest token.
  const existingInvites = storage.listWorkspaceInvites(workspace_id);
  const prior = existingInvites.find(i => i.email === normalized && i.status === 'pending');
  if (prior) storage.deleteWorkspaceInvite(prior.id);

  const id = generateId('inv');
  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  
  const invite = storage.createWorkspaceInvite({
    id,
    workspace_id,
    email: normalized,
    role,
    invited_by_user_id: ctx.user_id,
    token,
    status: 'pending',
    expires_at: expiresAt,
  });

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
  const invite = storage.getWorkspaceInviteByToken(token);
  if (!invite || invite.status !== 'pending') throw new InviteNotFoundError();
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    storage.updateWorkspaceInvite(invite.id, { status: 'expired' });
    throw new InviteExpiredError();
  }
  const user = storage.getUser(ctx.user_id);
  if (!user || !user.email) {
    throw new Error('caller user has no email — cannot match invite');
  }
  if (user.email.toLowerCase() !== invite.email) {
    throw new InviteNotFoundError();
  }
  const role = isValidRole(invite.role) ? invite.role : 'editor';
  storage.acceptInviteWithMember({
    invite_id: invite.id,
    workspace_id: invite.workspace_id,
    user_id: ctx.user_id,
    role,
  });
  
  const after = storage.getMemberRole(invite.workspace_id, ctx.user_id);
  if (!after) throw new Error('acceptInvite: failed to join workspace');
  return {
    workspace_id: invite.workspace_id,
    user_id: ctx.user_id,
    role: after,
    joined_at: new Date().toISOString(), // stub since we don't return the full record from the adapter easily
  } as WorkspaceMemberRecord;
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
  return storage.listWorkspaceInvites(workspace_id);
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
  const invite = storage.getWorkspaceInvite(invite_id);
  if (invite && invite.workspace_id === workspace_id && invite.status === 'pending') {
    storage.updateWorkspaceInvite(invite_id, { status: 'revoked' });
  }
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
  return storage.getActiveWorkspaceId(user_id);
}

/**
 * Switch the user's active workspace. Caller must be a member.
 */
export function switchActiveWorkspace(
  ctx: SessionContext,
  workspace_id: string,
): void {
  assertRole(ctx, workspace_id, 'viewer');
  storage.setActiveWorkspaceId(ctx.user_id, workspace_id);
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
  // Pentest LOW #387 — an unauthenticated visitor in cloud mode is bound
  // to the synthetic local user/workspace purely for tenant isolation;
  // the workspace_members row is auto-inserted at boot with
  // `role='admin'` so local OSS operators are admin of their own box.
  // For cloud visitors that same row makes `/api/session/me` return
  // `role: 'admin'` — a landmine for any frontend gate that checks
  // `role === 'admin'` without also asserting `is_local === false`.
  //
  // Treat a request as "guest" iff cloud mode is on AND the session
  // resolver fell through to the synthetic local user (no Better Auth
  // session). In that case, advertise `role: 'guest'` and an empty
  // workspaces list. Server-side authorization must NEVER trust this
  // field — routes call `assertRole(ctx, workspace_id, ...)` against
  // the DB instead. The field is a UX hint only.
  const isGuest =
    cloud_mode &&
    ctx.user_id === DEFAULT_USER_ID &&
    !ctx.is_authenticated;
  const active: { workspace: WorkspaceRecord; role: WorkspaceRole } = isGuest
    ? {
        workspace: storage.getWorkspace(DEFAULT_WORKSPACE_ID) as WorkspaceRecord,
        role: 'guest',
      }
    : memberships.find((m) => m.workspace.id === activeId) || {
        workspace: storage.getWorkspace(DEFAULT_WORKSPACE_ID) as WorkspaceRecord,
        role: 'admin',
      };
  const userRow = storage.getUser(ctx.user_id);
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
    betterAuthUser = storage.getBetterAuthUser(ctx.user_id);
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
    // Pentest LOW #387 — guests see an empty workspace list. The synthetic
    // local workspace is a tenant-isolation backstop, not something the UI
    // should render as an available option.
    workspaces: isGuest
      ? []
      : memberships.map((m) => ({
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
    // DEPLOY_ENABLED gates every Deploy / Publish CTA in the web UI.
    // Default-false ("waitlist mode") so a misconfigured prod box never
    // accidentally exposes the deploy flow. preview.floom.dev opts in
    // with DEPLOY_ENABLED=true to keep the full flow available for
    // internal dogfooding. Self-hosters can also flip it on to keep
    // their workflows unchanged — the waitlist form still works in
    // that mode, it just isn't the default affordance anymore.
    deploy_enabled: isDeployEnabled(),
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
  const existing = storage.listWorkspacesForUser(user_id)[0];

  if (existing) {
    storage.setActiveWorkspaceId(user_id, existing.id);
    return existing.id;
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

  storage.createWorkspaceWithMember({
    workspace: {
      id,
      slug,
      name: workspaceName,
      plan: 'cloud_free',
    },
    user_id,
    role: 'admin',
  });

  return id;
}

/**
 * Waitlist / deploy-enabled gate for `/api/session/me.deploy_enabled`.
 *
 * Default semantics (launch-audit 2026-04-24, P0 #605): publishing is
 * ENABLED unless explicitly disabled. Previously `DEPLOY_ENABLED`
 * defaulted to `false` when unset, so every container that forgot the
 * env var rendered "join the waitlist" copy ten times on the homepage
 * despite the runtime actually being open. The fix flips the default
 * and requires an explicit opt-in to turn waitlist mode back on.
 *
 * Resolution order (first hit wins):
 *   1. `FLOOM_WAITLIST_MODE` truthy → waitlist ON (deploy_enabled=false)
 *   2. Legacy `DEPLOY_ENABLED` truthy → deploy_enabled=true
 *   3. Legacy `DEPLOY_ENABLED` falsy  → deploy_enabled=false
 *   4. Nothing set → deploy_enabled=true (open by default)
 *
 * Module-local so tests and `/api/session/me` read the same gate.
 */
export function isDeployEnabled(): boolean {
  // Explicit opt-in to waitlist mode wins.
  const wait = (process.env.FLOOM_WAITLIST_MODE || '').trim().toLowerCase();
  if (wait === 'true' || wait === '1' || wait === 'yes' || wait === 'on') {
    return false;
  }
  // Legacy DEPLOY_ENABLED: still honored when set.
  const raw = (process.env.DEPLOY_ENABLED || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  // Default: publishing enabled.
  return true;
}
