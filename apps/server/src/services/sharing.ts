import { newAppInviteId, newVisibilityAuditId } from '../lib/ids.js';
import { auditLog } from './audit-log.js';
import { generateLinkShareToken } from '../lib/link-share-token.js';
import type { StorageAdapter } from '../adapters/types.js';
import type {
  AppInviteState,
  AppRecord,
  AppVisibility,
  AppVisibilityState,
  SessionContext,
} from '../types.js';

async function storage(): Promise<StorageAdapter> {
  return (await import('../adapters/index.js')).adapters.storage;
}

export const VISIBILITY_STATES = [
  'private',
  'link',
  'invited',
  'pending_review',
  'public_live',
  'changes_requested',
] as const satisfies readonly AppVisibilityState[];

export const INVITE_STATES = [
  'pending_email',
  'pending_accept',
  'accepted',
  'revoked',
  'declined',
] as const satisfies readonly AppInviteState[];

export type TransitionReason =
  | 'owner_set_private'
  | 'owner_enable_link'
  | 'owner_set_invited'
  | 'owner_submit_review'
  | 'owner_withdraw_review'
  | 'owner_resubmit_review'
  | 'owner_unlist'
  | 'admin_approve'
  | 'admin_reject'
  | 'admin_takedown';

export interface TransitionOptions {
  actorUserId: string;
  actorTokenId?: string | null;
  actorIp?: string | null;
  reason: TransitionReason;
  comment?: string | null;
  rotateLinkToken?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AppInviteRow {
  id: string;
  app_id: string;
  invited_user_id: string | null;
  invited_email: string | null;
  state: AppInviteState;
  created_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  invited_by_user_id: string;
  invited_user_name?: string | null;
  invited_user_email?: string | null;
}

export interface VisibilityAuditRow {
  id: string;
  app_id: string;
  from_state: string | null;
  to_state: string;
  actor_user_id: string;
  reason: string;
  metadata: string | null;
  created_at: string;
}

export function isVisibilityState(value: string | null | undefined): value is AppVisibilityState {
  return VISIBILITY_STATES.includes(value as AppVisibilityState);
}

export function canonicalVisibility(value: AppVisibility | string | null | undefined): AppVisibilityState {
  if (isVisibilityState(value)) return value;
  if (value === 'public') return 'public_live';
  return 'private';
}

export function isPublicListingVisibility(value: string | null | undefined): boolean {
  return value === 'public_live' || value === 'public' || value === null;
}

export function isPubliclyRunnableVisibility(value: string | null | undefined): boolean {
  return value === 'public_live' || value === 'public';
}

export async function verifyLinkToken(slug: string, providedKey: string | null | undefined): Promise<boolean> {
  if (!providedKey) return false;
  const row = await (await storage()).getLinkShareByAppSlug(slug);
  return Boolean(row?.link_share_token && row.link_share_token === providedKey);
}

function ownerMatches(app: Pick<AppRecord, 'author' | 'workspace_id'>, ctx: SessionContext): boolean {
  if (app.author && app.author === ctx.user_id) return true;
  return !ctx.is_authenticated && ctx.workspace_id === 'local' && app.workspace_id === 'local';
}

export function isAppOwner(app: Pick<AppRecord, 'author' | 'workspace_id'>, ctx: SessionContext): boolean {
  return ownerMatches(app, ctx);
}

function readOwnerMatches(app: Pick<AppRecord, 'author'>, ctx: SessionContext): boolean {
  return Boolean(app.author && app.author === ctx.user_id);
}

export function userHasAcceptedInvite(appId: string, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return Promise.resolve(false);
  return storage().then((s) => s.userHasAcceptedAppInvite(appId, userId));
}

export async function canAccessApp(
  app: Pick<AppRecord, 'id' | 'author' | 'workspace_id' | 'link_share_token'> & {
    slug?: string | null;
    visibility: AppVisibility | string | null | undefined;
    link_share_requires_auth?: number | boolean | null;
  },
  ctx: SessionContext,
  linkToken?: string | null,
): Promise<boolean> {
  const visibility = canonicalVisibility(app.visibility);
  if (visibility === 'public_live') return true;
  if (visibility === 'private' || visibility === 'pending_review' || visibility === 'changes_requested') {
    return readOwnerMatches(app, ctx);
  }
  if (visibility === 'link') {
    const validToken = app.slug
      ? await verifyLinkToken(app.slug, linkToken)
      : Boolean(app.link_share_token && linkToken && app.link_share_token === linkToken);
    if (!validToken) return false;
    if (app.link_share_requires_auth) return ctx.is_authenticated;
    return true;
  }
  if (visibility === 'invited') {
    return readOwnerMatches(app, ctx) || await userHasAcceptedInvite(app.id, ctx.user_id);
  }
  return false;
}

export type AppAccessDecision = { ok: true } | { ok: false; status: 401 | 404 };

export async function getAppAccessDecision(
  app: Pick<AppRecord, 'id' | 'author' | 'workspace_id' | 'link_share_token'> & {
    slug?: string | null;
    visibility: AppVisibility | string | null | undefined;
    link_share_requires_auth?: number | boolean | null;
  },
  ctx: SessionContext,
  linkToken?: string | null,
): Promise<AppAccessDecision> {
  const visibility = canonicalVisibility(app.visibility);
  if (visibility !== 'link') {
    return (await canAccessApp(app, ctx, linkToken)) ? { ok: true } : { ok: false, status: 404 };
  }

  const validToken = app.slug
    ? await verifyLinkToken(app.slug, linkToken)
    : Boolean(app.link_share_token && linkToken && app.link_share_token === linkToken);
  if (validToken && (!app.link_share_requires_auth || ctx.is_authenticated)) {
    return { ok: true };
  }
  if (app.link_share_requires_auth && !ctx.is_authenticated && (!linkToken || validToken)) {
    return { ok: false, status: 401 };
  }
  return { ok: false, status: 404 };
}

export function assertLegalTransition(
  from: AppVisibilityState,
  to: AppVisibilityState,
  reason: TransitionReason,
): void {
  if (reason === 'admin_takedown') {
    if (to === 'private') return;
    throw new Error('admin_takedown_must_target_private');
  }
  if (reason === 'owner_withdraw_review') {
    if (from === 'pending_review' && to === 'private') return;
    throw new Error('illegal_transition');
  }

  const allowed: Record<AppVisibilityState, AppVisibilityState[]> = {
    private: ['link', 'invited', 'pending_review'],
    link: ['private'],
    invited: ['private'],
    pending_review: ['public_live', 'changes_requested'],
    public_live: ['private'],
    changes_requested: ['pending_review'],
  };

  if (allowed[from]?.includes(to)) return;
  throw new Error('illegal_transition');
}

async function auditTransition(
  appId: string,
  fromState: string | null,
  toState: string,
  actorUserId: string,
  actorTokenId: string | null | undefined,
  actorIp: string | null | undefined,
  reason: string,
  beforeState: Record<string, unknown>,
  afterState: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await (await storage()).createVisibilityAudit({
    id: newVisibilityAuditId(),
    app_id: appId,
    from_state: fromState,
    to_state: toState,
    actor_user_id: actorUserId,
    reason,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
  auditLog({
    actor: { userId: actorUserId, tokenId: actorTokenId || null, ip: actorIp || null },
    action:
      reason === 'admin_approve'
        ? 'admin.app_approved'
        : reason === 'admin_reject'
          ? 'admin.app_rejected'
          : reason === 'admin_takedown'
            ? 'admin.app_takedown'
            : 'app.visibility_changed',
    target: { type: 'app', id: appId },
    before: beforeState,
    after: afterState,
    metadata: {
      reason,
      ...(metadata || {}),
    },
  });
}

export async function transitionVisibility(
  app: AppRecord,
  to: AppVisibilityState,
  options: TransitionOptions,
): Promise<AppRecord> {
  const from = canonicalVisibility(app.visibility);
  assertLegalTransition(from, to, options.reason);

  let linkToken: string | null = null;
  if (to === 'link') {
    linkToken =
      options.rotateLinkToken || !app.link_share_token
        ? generateLinkShareToken()
        : app.link_share_token;
  }

  const publishStatus = to === 'public_live' ? 'published' : to === 'pending_review' ? 'pending_review' : app.publish_status;

  const apply = async () => {
    const patch: Parameters<StorageAdapter['updateAppSharing']>[1] = {
      visibility: to,
      link_share_token: linkToken,
      publish_status: publishStatus,
      review_submitted_at: to === 'pending_review' ? new Date().toISOString() : app.review_submitted_at,
      review_decided_at:
        to === 'public_live' || to === 'changes_requested'
          ? new Date().toISOString()
          : app.review_decided_at,
      review_decided_by:
        to === 'public_live' || to === 'changes_requested'
          ? options.actorUserId
          : app.review_decided_by,
      review_comment:
        to === 'changes_requested'
          ? options.comment || ''
          : to === 'pending_review'
            ? null
            : app.review_comment,
    };
    const updated = await (await storage()).updateAppSharing(app.id, patch);
    if (!updated) throw new Error(`app not found: ${app.id}`);

    await auditTransition(
      app.id,
      from,
      to,
      options.actorUserId,
      options.actorTokenId,
      options.actorIp,
      options.reason,
      { visibility: from, publish_status: app.publish_status },
      { visibility: to, publish_status: publishStatus },
      {
        ...(options.metadata || {}),
        ...(options.comment ? { comment: options.comment } : {}),
      },
    );

    return updated;
  };

  return apply();
}

export async function listInvites(appId: string): Promise<AppInviteRow[]> {
  return (await storage()).listAppInvites(appId) as Promise<AppInviteRow[]>;
}

export async function findUserByUsername(username: string): Promise<{ id: string; email: string | null; name: string | null } | null> {
  const normalized = username.trim().replace(/^@/, '').toLowerCase();
  if (!normalized) return null;
  const row = await (await storage()).findUserByUsername(normalized);
  return row || null;
}

export async function findUserByEmail(email: string): Promise<{ id: string; email: string | null; name: string | null } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const row = await (await storage()).getUserByEmail(normalized);
  return row || null;
}

export async function upsertInvite(params: {
  appId: string;
  invitedByUserId: string;
  invitedUserId?: string | null;
  invitedEmail?: string | null;
  state: AppInviteState;
}): Promise<AppInviteRow> {
  const id = newAppInviteId();
  return (await storage()).upsertAppInvite({
    id,
    app_id: params.appId,
    invited_user_id: params.invitedUserId || null,
    invited_email: params.invitedEmail || null,
    state: params.state,
    invited_by_user_id: params.invitedByUserId,
  }) as Promise<AppInviteRow>;
}

export async function revokeInvite(inviteId: string, appId: string): Promise<AppInviteRow | null> {
  return (await (await storage()).revokeAppInvite(inviteId, appId) as AppInviteRow | undefined) || null;
}

export async function acceptInvite(inviteId: string, userId: string): Promise<{ invite: AppInviteRow | null; changed: boolean }> {
  const result = await (await storage()).acceptAppInvite(inviteId, userId);
  return { invite: (result.invite as AppInviteRow | undefined) || null, changed: result.changed };
}

export async function declineInvite(inviteId: string, userId: string): Promise<AppInviteRow | null> {
  return (await (await storage()).declineAppInvite(inviteId, userId) as AppInviteRow | undefined) || null;
}

export async function linkPendingEmailInvites(userId: string, email: string): Promise<number> {
  return (await storage()).linkPendingEmailAppInvites(userId, email);
}

export async function listPendingInvitesForUser(userId: string): Promise<AppInviteRow[]> {
  return (await storage()).listPendingAppInvitesForUser(userId) as Promise<AppInviteRow[]>;
}

export async function listAuditRows(appId?: string | null): Promise<VisibilityAuditRow[]> {
  return (await storage()).listVisibilityAudit(appId) as Promise<VisibilityAuditRow[]>;
}
