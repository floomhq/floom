import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { cleanupUserOrphans } from './cleanup.js';

const DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type AccountDeleteAction =
  | 'account.soft_deleted'
  | 'account.delete_undone'
  | 'account.permanent_deleted';

export interface PendingDeleteUser {
  id: string;
  email: string | null;
  name: string | null;
  deleted_at: string | null;
  delete_at: string | null;
}

export class AccountDeleteError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AccountDeleteError';
    this.status = status;
    this.code = code;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function tableExists(table: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { ok: number } | undefined;
  return Boolean(row);
}

function columnNames(table: string): Set<string> {
  if (!tableExists(table)) return new Set();
  return new Set(
    (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[])
      .map((row) => row.name),
  );
}

function deleteWhereIfColumn(table: string, column: string, value: string): number {
  const cols = columnNames(table);
  if (!cols.has(column)) return 0;
  const res = db
    .prepare(`DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} = ?`)
    .run(value);
  return Number(res.changes || 0);
}

export function revokeAccountSessions(userId: string): number {
  return deleteWhereIfColumn('session', 'userId', userId);
}

function deleteBetterAuthUserState(userId: string): void {
  revokeAccountSessions(userId);
  deleteWhereIfColumn('account', 'userId', userId);
  deleteWhereIfColumn('apikey', 'referenceId', userId);
  deleteWhereIfColumn('member', 'userId', userId);
  deleteWhereIfColumn('invitation', 'inviterId', userId);
  deleteWhereIfColumn('verification', 'value', userId);
  deleteWhereIfColumn('user', 'id', userId);
}

function stateFor(row: Pick<PendingDeleteUser, 'deleted_at' | 'delete_at'> | null): string {
  if (!row) return 'missing';
  return row.deleted_at ? 'soft_deleted' : 'active';
}

export function writeAccountAudit(
  action: AccountDeleteAction,
  actorUserId: string | null,
  targetUserId: string,
  beforeState: string,
  afterState: string,
  metadata: Record<string, unknown> = {},
): void {
  const cols = columnNames('audit_log');
  if (cols.size === 0) return;

  const values: Record<string, unknown> = {
    id: randomUUID(),
    actor_user_id: actorUserId,
    action,
    target_type: 'user',
    target_id: targetUserId,
    before_state: beforeState,
    after_state: afterState,
    metadata: JSON.stringify(metadata),
    created_at: nowIso(),
  };
  const insertCols = Object.keys(values).filter((col) => cols.has(col));
  if (insertCols.length === 0) return;
  try {
    db.prepare(
      `INSERT INTO audit_log (${insertCols.map(quoteIdent).join(', ')})
       VALUES (${insertCols.map(() => '?').join(', ')})`,
    ).run(...insertCols.map((col) => values[col]));
  } catch (err) {
    console.warn(`[account-delete] audit write failed for ${action}:`, err);
  }
}

export function getUserDeletionStateByEmail(email: string): PendingDeleteUser | null {
  const normalized = normalizeEmail(email);
  return (
    (db
      .prepare(
        `SELECT id, email, name, deleted_at, delete_at
           FROM users
          WHERE LOWER(email) = ?
          LIMIT 1`,
      )
      .get(normalized) as PendingDeleteUser | undefined) || null
  );
}

export function getUserDeletionState(userId: string): PendingDeleteUser | null {
  return (
    (db
      .prepare(
        `SELECT id, email, name, deleted_at, delete_at
           FROM users
          WHERE id = ?
          LIMIT 1`,
      )
      .get(userId) as PendingDeleteUser | undefined) || null
  );
}

export function listPendingAccountDeletes(): PendingDeleteUser[] {
  return db
    .prepare(
      `SELECT id, email, name, deleted_at, delete_at
         FROM users
        WHERE deleted_at IS NOT NULL
        ORDER BY delete_at ASC`,
    )
    .all() as PendingDeleteUser[];
}

export function isDeleteExpired(
  row: Pick<PendingDeleteUser, 'deleted_at' | 'delete_at'>,
  at: Date = new Date(),
): boolean {
  if (!row.deleted_at || !row.delete_at) return false;
  return new Date(row.delete_at).getTime() <= at.getTime();
}

export function buildUndoUrl(email?: string | null): string {
  const base =
    process.env.FLOOM_APP_URL ||
    process.env.PUBLIC_URL ||
    process.env.BETTER_AUTH_URL ||
    `http://localhost:${process.env.PORT || 3051}`;
  const url = new URL('/delete-account/undo', base);
  if (email) url.searchParams.set('email', email);
  return url.toString();
}

export function softDeletedSignInBody(row: PendingDeleteUser): {
  error: string;
  code: string;
  delete_at: string | null;
  undo_url: string;
} {
  return {
    error: 'Account deletion is pending. Undo deletion before signing in.',
    code: 'account_pending_delete',
    delete_at: row.delete_at,
    undo_url: buildUndoUrl(row.email),
  };
}

export function initiateAccountSoftDelete(
  userId: string,
  confirmEmail: string,
): { deleted_at: string; delete_at: string } {
  const normalized = normalizeEmail(confirmEmail);
  const user = getUserDeletionState(userId);
  if (!user) {
    throw new AccountDeleteError(404, 'not_found', 'Account not found.');
  }
  if (!user.email || normalizeEmail(user.email) !== normalized) {
    throw new AccountDeleteError(422, 'invalid_confirm_email', 'Confirmation email does not match.');
  }
  if (user.deleted_at) {
    throw new AccountDeleteError(409, 'account_pending_delete', 'Account deletion is already pending.');
  }

  const deletedAt = nowIso();
  const deleteAt = new Date(Date.now() + DELETE_GRACE_MS).toISOString();
  const tx = db.transaction(() => {
    const update = db.prepare(
      `UPDATE users
          SET deleted_at = ?,
              delete_at = ?
        WHERE id = ? AND deleted_at IS NULL`,
    ).run(deletedAt, deleteAt, userId);
    if (Number(update.changes || 0) !== 1) {
      throw new AccountDeleteError(409, 'account_pending_delete', 'Account deletion is already pending.');
    }
    revokeAccountSessions(userId);
    writeAccountAudit('account.soft_deleted', userId, userId, 'active', 'soft_deleted', {
      deleted_at: deletedAt,
      delete_at: deleteAt,
    });
  });
  tx();
  return { deleted_at: deletedAt, delete_at: deleteAt };
}

export function undoAccountSoftDelete(confirmEmail: string): PendingDeleteUser {
  const row = getUserDeletionStateByEmail(confirmEmail);
  if (!row || !row.deleted_at) {
    throw new AccountDeleteError(404, 'not_found', 'Pending account deletion not found.');
  }
  if (isDeleteExpired(row)) {
    throw new AccountDeleteError(410, 'account_delete_expired', 'Account deletion grace period has expired.');
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE users
          SET deleted_at = NULL,
              delete_at = NULL
        WHERE id = ? AND deleted_at IS NOT NULL`,
    ).run(row.id);
    writeAccountAudit('account.delete_undone', row.id, row.id, 'soft_deleted', 'active', {
      deleted_at: row.deleted_at,
      delete_at: row.delete_at,
    });
  });
  tx();
  const restored = getUserDeletionState(row.id);
  if (!restored) {
    throw new AccountDeleteError(404, 'not_found', 'Account not found after restore.');
  }
  return restored;
}

export function permanentDeleteAccount(userId: string): boolean {
  const before = getUserDeletionState(userId);
  if (!before) return false;

  writeAccountAudit('account.permanent_deleted', null, userId, stateFor(before), 'permanent_deleted', {
    deleted_at: before.deleted_at,
    delete_at: before.delete_at,
  });
  cleanupUserOrphans(userId);
  deleteBetterAuthUserState(userId);
  return true;
}

export function permanentlyDeleteExpiredAccountForEmail(email: string): boolean {
  const row = getUserDeletionStateByEmail(email);
  if (!row || !row.deleted_at || !isDeleteExpired(row)) return false;
  return permanentDeleteAccount(row.id);
}

export function sweepExpiredAccountDeletes(): { scanned: number; deleted: number; failed: number } {
  const now = nowIso();
  const rows = db
    .prepare(
      `SELECT id, email, name, deleted_at, delete_at
         FROM users
        WHERE deleted_at IS NOT NULL
          AND delete_at IS NOT NULL
          AND delete_at <= ?
        ORDER BY delete_at ASC`,
    )
    .all(now) as PendingDeleteUser[];

  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (permanentDeleteAccount(row.id)) deleted++;
    } catch (err) {
      failed++;
      console.warn(`[account-delete] permanent delete failed for user ${row.id}:`, err);
    }
  }
  console.log(
    `[account-delete] sweep scanned=${rows.length} deleted=${deleted} failed=${failed}`,
  );
  return { scanned: rows.length, deleted, failed };
}

let sweeperTimer: NodeJS.Timeout | null = null;

export function startAccountDeleteSweeper(): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    sweepExpiredAccountDeletes();
  }, SWEEP_INTERVAL_MS);
  sweeperTimer.unref?.();
  console.log('[account-delete] sweeper scheduled every 1h');
}

export function stopAccountDeleteSweeperForTests(): void {
  if (!sweeperTimer) return;
  clearInterval(sweeperTimer);
  sweeperTimer = null;
}
