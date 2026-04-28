import { db } from '../db.js';
import { newAppInviteId, newVisibilityAuditId } from '../lib/ids.js';
import { auditLog } from './audit-log.js';
import { generateLinkShareToken } from '../lib/link-share-token.js';
import type {
  AppInviteState,
  AppRecord,
  AppVisibility,
  AppVisibilityState,
  SessionContext,
} from '../types.js';

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

export function verifyLinkToken(slug: string, providedKey: string | null | undefined): boolean {
  if (!providedKey) return false;
  const row = db
    .prepare(`SELECT link_share_token FROM apps WHERE slug = ?`)
    .get(slug) as { link_share_token: string | null } | undefined;
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

export function userHasAcceptedInvite(appId: string, userId: string | null | undefined): boolean {
  if (!userId) return false;
  const row = db
    .prepare(
      `SELECT 1 AS ok
         FROM app_invites
        WHERE app_id = ?
          AND invited_user_id = ?
          AND state = 'accepted'
        LIMIT 1`,
    )
    .get(appId, userId) as { ok: number } | undefined;
  return Boolean(row);
}

export function canAccessApp(
  app: Pick<AppRecord, 'id' | 'author' | 'workspace_id' | 'link_share_token'> & {
    slug?: string | null;
    visibility: AppVisibility | string | null | undefined;
    link_share_requires_auth?: number | boolean | null;
  },
  ctx: SessionContext,
  linkToken?: string | null,
): boolean {
  const visibility = canonicalVisibility(app.visibility);
  if (visibility === 'public_live') return true;
  if (visibility === 'private' || visibility === 'pending_review' || visibility === 'changes_requested') {
    return readOwnerMatches(app, ctx);
  }
  if (visibility === 'link') {
    const validToken = app.slug
      ? verifyLinkToken(app.slug, linkToken)
      : Boolean(app.link_share_token && linkToken && app.link_share_token === linkToken);
    if (!validToken) return false;
    if (app.link_share_requires_auth) return ctx.is_authenticated;
    return true;
  }
  if (visibility === 'invited') {
    return readOwnerMatches(app, ctx) || userHasAcceptedInvite(app.id, ctx.user_id);
  }
  return false;
}

export type AppAccessDecision = { ok: true } | { ok: false; status: 401 | 404 };

export function getAppAccessDecision(
  app: Pick<AppRecord, 'id' | 'author' | 'workspace_id' | 'link_share_token'> & {
    slug?: string | null;
    visibility: AppVisibility | string | null | undefined;
    link_share_requires_auth?: number | boolean | null;
  },
  ctx: SessionContext,
  linkToken?: string | null,
): AppAccessDecision {
  const visibility = canonicalVisibility(app.visibility);
  if (visibility !== 'link') {
    return canAccessApp(app, ctx, linkToken) ? { ok: true } : { ok: false, status: 404 };
  }

  const validToken = app.slug
    ? verifyLinkToken(app.slug, linkToken)
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
    link: ['private', 'link'],
    invited: ['private'],
    pending_review: ['public_live', 'changes_requested'],
    public_live: ['private'],
    changes_requested: ['pending_review'],
  };

  if (allowed[from]?.includes(to)) return;
  throw new Error('illegal_transition');
}

function auditTransition(
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
): void {
  db.prepare(
    `INSERT INTO app_visibility_audit
       (id, app_id, from_state, to_state, actor_user_id, reason, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newVisibilityAuditId(),
    appId,
    fromState,
    toState,
    actorUserId,
    reason,
    metadata ? JSON.stringify(metadata) : null,
  );
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

export function transitionVisibility(
  app: AppRecord,
  to: AppVisibilityState,
  options: TransitionOptions,
): AppRecord {
  const from = canonicalVisibility(app.visibility);
  assertLegalTransition(from, to, options.reason);

  let linkToken: string | null = null;
  if (to === 'link') {
    linkToken =
      options.rotateLinkToken || !app.link_share_token
        ? generateLinkShareToken()
        : app.link_share_token;
  }

  const reviewSubmittedAt = to === 'pending_review' ? "datetime('now')" : 'review_submitted_at';
  const reviewDecidedAt =
    to === 'public_live' || to === 'changes_requested' ? "datetime('now')" : 'review_decided_at';
  const reviewDecidedBy =
    to === 'public_live' || to === 'changes_requested' ? '?' : 'review_decided_by';
  const reviewComment = to === 'changes_requested' ? '?' : to === 'pending_review' ? 'NULL' : 'review_comment';
  const publishStatus = to === 'public_live' ? 'published' : to === 'pending_review' ? 'pending_review' : app.publish_status;

  const values: unknown[] = [to, linkToken, publishStatus];
  if (to === 'public_live' || to === 'changes_requested') values.push(options.actorUserId);
  if (to === 'changes_requested') values.push(options.comment || '');
  values.push(app.id);

  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE apps
          SET visibility = ?,
              link_share_token = ?,
              publish_status = ?,
              review_submitted_at = ${reviewSubmittedAt},
              review_decided_at = ${reviewDecidedAt},
              review_decided_by = ${reviewDecidedBy},
              review_comment = ${reviewComment},
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(...values);

    auditTransition(
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

    return db.prepare(`SELECT * FROM apps WHERE id = ?`).get(app.id) as AppRecord;
  });

  return apply();
}

export function listInvites(appId: string): AppInviteRow[] {
  return db
    .prepare(
      `SELECT app_invites.*,
              users.name AS invited_user_name,
              users.email AS invited_user_email
         FROM app_invites
         LEFT JOIN users ON users.id = app_invites.invited_user_id
        WHERE app_invites.app_id = ?
        ORDER BY app_invites.created_at DESC`,
    )
    .all(appId) as AppInviteRow[];
}

export function findUserByUsername(username: string): { id: string; email: string | null; name: string | null } | null {
  const normalized = username.trim().replace(/^@/, '').toLowerCase();
  if (!normalized) return null;
  const row = db
    .prepare(
      `SELECT id, email, name
         FROM users
        WHERE LOWER(name) = ?
           OR LOWER(email) = ?
           OR LOWER(substr(email, 1, instr(email, '@') - 1)) = ?
        LIMIT 1`,
    )
    .get(normalized, normalized, normalized) as { id: string; email: string | null; name: string | null } | undefined;
  return row || null;
}

export function findUserByEmail(email: string): { id: string; email: string | null; name: string | null } | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const row = db
    .prepare(`SELECT id, email, name FROM users WHERE LOWER(email) = ? LIMIT 1`)
    .get(normalized) as { id: string; email: string | null; name: string | null } | undefined;
  return row || null;
}

export function upsertInvite(params: {
  appId: string;
  invitedByUserId: string;
  invitedUserId?: string | null;
  invitedEmail?: string | null;
  state: AppInviteState;
}): AppInviteRow {
  const existing = db
    .prepare(
      `SELECT * FROM app_invites
        WHERE app_id = ?
          AND (
            (? IS NOT NULL AND invited_user_id = ?)
            OR (? IS NOT NULL AND LOWER(invited_email) = LOWER(?))
          )
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(
      params.appId,
      params.invitedUserId || null,
      params.invitedUserId || null,
      params.invitedEmail || null,
      params.invitedEmail || null,
    ) as AppInviteRow | undefined;

  if (existing && !['revoked', 'declined'].includes(existing.state)) {
    return existing;
  }

  const id = newAppInviteId();
  db.prepare(
    `INSERT INTO app_invites
       (id, app_id, invited_user_id, invited_email, state, invited_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.appId,
    params.invitedUserId || null,
    params.invitedEmail || null,
    params.state,
    params.invitedByUserId,
  );
  return db.prepare(`SELECT * FROM app_invites WHERE id = ?`).get(id) as AppInviteRow;
}

export function revokeInvite(inviteId: string, appId: string): AppInviteRow | null {
  const invite = db
    .prepare(`SELECT * FROM app_invites WHERE id = ? AND app_id = ?`)
    .get(inviteId, appId) as AppInviteRow | undefined;
  if (!invite) return null;
  if (invite.state === 'revoked') return invite;
  db.prepare(
    `UPDATE app_invites
        SET state = 'revoked',
            revoked_at = datetime('now')
      WHERE id = ?`,
  ).run(invite.id);
  return db.prepare(`SELECT * FROM app_invites WHERE id = ?`).get(invite.id) as AppInviteRow;
}

export function acceptInvite(inviteId: string, userId: string): { invite: AppInviteRow | null; changed: boolean } {
  const invite = db
    .prepare(`SELECT * FROM app_invites WHERE id = ?`)
    .get(inviteId) as AppInviteRow | undefined;
  if (!invite || invite.invited_user_id !== userId) return { invite: null, changed: false };
  if (invite.state === 'accepted') return { invite, changed: false };
  if (invite.state !== 'pending_accept') return { invite, changed: false };
  db.prepare(
    `UPDATE app_invites
        SET state = 'accepted',
            accepted_at = datetime('now')
      WHERE id = ?`,
  ).run(invite.id);
  return {
    invite: db.prepare(`SELECT * FROM app_invites WHERE id = ?`).get(invite.id) as AppInviteRow,
    changed: true,
  };
}

export function declineInvite(inviteId: string, userId: string): AppInviteRow | null {
  const invite = db
    .prepare(`SELECT * FROM app_invites WHERE id = ?`)
    .get(inviteId) as AppInviteRow | undefined;
  if (!invite || invite.invited_user_id !== userId) return null;
  if (invite.state === 'accepted' || invite.state === 'pending_accept') {
    db.prepare(`UPDATE app_invites SET state = 'declined' WHERE id = ?`).run(invite.id);
  }
  return db.prepare(`SELECT * FROM app_invites WHERE id = ?`).get(invite.id) as AppInviteRow;
}

export function linkPendingEmailInvites(userId: string, email: string): number {
  const result = db
    .prepare(
      `UPDATE app_invites
          SET invited_user_id = ?,
              state = 'pending_accept'
        WHERE state = 'pending_email'
          AND LOWER(invited_email) = LOWER(?)`,
    )
    .run(userId, email);
  return result.changes;
}

export function listPendingInvitesForUser(userId: string): AppInviteRow[] {
  return db
    .prepare(
      `SELECT app_invites.*,
              apps.slug AS app_slug,
              apps.name AS app_name,
              apps.description AS app_description
         FROM app_invites
         JOIN apps ON apps.id = app_invites.app_id
        WHERE app_invites.invited_user_id = ?
          AND app_invites.state = 'pending_accept'
        ORDER BY app_invites.created_at DESC`,
    )
    .all(userId) as AppInviteRow[];
}

export function listAuditRows(appId?: string | null): VisibilityAuditRow[] {
  if (appId) {
    return db
      .prepare(
        `SELECT * FROM app_visibility_audit
          WHERE app_id = ?
          ORDER BY created_at DESC`,
      )
      .all(appId) as VisibilityAuditRow[];
  }
  return db
    .prepare(`SELECT * FROM app_visibility_audit ORDER BY created_at DESC LIMIT 200`)
    .all() as VisibilityAuditRow[];
}
