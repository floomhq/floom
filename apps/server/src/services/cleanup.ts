import { db, DEFAULT_WORKSPACE_ID } from '../db.js';
import { invalidateHubCache } from '../lib/hub-cache.js';
import { deleteRunsForUserAccount } from './run-retention-sweeper.js';
import { auditLog } from './audit-log.js';

/**
 * Cleanup orphaned Floom data when a user is deleted from Better Auth.
 * 
 * Logic:
 * 1. Find all workspaces where the user was a member.
 * 2. Delete the user from Floom's mirrored `users` table.
 * 3. For each workspace:
 *    a. Check if any members remain.
 *    b. If no members remain (and the workspace isn't 'local'):
 *       - Delete apps that are not 'public'.
 *       - Re-assign 'public' apps to the 'local' workspace (orphaned by user, retained for Hub).
 *       - Clean up associated records in tables without FK CASCADE on workspace_id:
 *         run_threads, app_reviews, feedback, and per-app secrets.
 *       - Delete the workspace (triggers CASCADE for workspace_members, app_memory, etc.).
 */
export function cleanupUserOrphans(userId: string): void {
  const runCleanup = db.transaction(() => {
    // 1. Find workspaces where user is a member (inside transaction for consistency)
    const memberships = db
      .prepare('SELECT workspace_id, role FROM workspace_members WHERE user_id = ?')
      .all(userId) as { workspace_id: string; role: string }[];

    const user = db
      .prepare('SELECT id FROM users WHERE id = ?')
      .get(userId) as { id: string } | undefined;
    auditLog({
      actor: { userId },
      action: 'account.deleted',
      target: { type: 'user', id: userId },
      before: user
        ? {
            id: user.id,
            workspace_ids: memberships.map((membership) => membership.workspace_id),
          }
        : { id: userId },
      after: null,
      metadata: { mode: 'hard_delete' },
    });

    // If the departing user is the sole admin in a shared workspace,
    // promote the next most-active member before the FK removes the
    // membership row. Activity is approximated by run count in that
    // workspace, with joined_at as the deterministic fallback.
    for (const { workspace_id, role } of memberships) {
      if (workspace_id === DEFAULT_WORKSPACE_ID || role !== 'admin') continue;
      const counts = db
        .prepare(
          `SELECT
             COUNT(*) AS member_count,
             SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admin_count
           FROM workspace_members
           WHERE workspace_id = ?`,
        )
        .get(workspace_id) as { member_count: number; admin_count: number | null };
      if (counts.member_count <= 1 || Number(counts.admin_count || 0) > 1) continue;
      const successor = db
        .prepare(
          `SELECT m.user_id
             FROM workspace_members m
             LEFT JOIN runs r
               ON r.workspace_id = m.workspace_id
              AND r.user_id = m.user_id
            WHERE m.workspace_id = ?
              AND m.user_id != ?
            GROUP BY m.user_id, m.joined_at
            ORDER BY COUNT(r.id) DESC, m.joined_at ASC
            LIMIT 1`,
        )
        .get(workspace_id, userId) as { user_id: string } | undefined;
      if (successor) {
        db.prepare(
          `UPDATE workspace_members
              SET role = 'admin'
            WHERE workspace_id = ? AND user_id = ?`,
        ).run(workspace_id, successor.user_id);
      }
    }

    // 2. Clear global user state
    db.prepare('DELETE FROM workspace_invites WHERE invited_by_user_id = ?').run(userId);
    db.prepare('DELETE FROM app_invites WHERE invited_by_user_id = ?').run(userId);
    db.prepare('UPDATE app_invites SET invited_user_id = NULL WHERE invited_user_id = ?').run(userId);
    db.prepare('DELETE FROM agent_tokens WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_secrets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM app_memory WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM runs WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM run_threads WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM app_reviews WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM feedback WHERE user_id = ?').run(userId);

    // a. Delete per-app secrets for the private apps we're about to drop.
    //    `secrets.app_id` has no FK CASCADE on apps, so without this the
    //    secret rows would survive as orphans after the app row is gone
    //    (observable as "ghost" entries via /api/secrets).
    db.prepare(`
      DELETE FROM secrets
      WHERE app_id IN (
        SELECT id FROM apps
        WHERE author = ?
          AND (visibility != 'public' OR visibility IS NULL)
      )
    `).run(userId);

    // b. Delete private apps authored by this user across ALL workspaces
    db.prepare(`
      DELETE FROM apps
      WHERE author = ?
        AND (visibility != 'public' OR visibility IS NULL)
    `).run(userId);

    // c. Migrate public apps authored by this user
    db.prepare(`
      UPDATE apps
      SET author = NULL,
          workspace_id = 'local',
          visibility = 'public'
      WHERE author = ?
        AND visibility = 'public'
    `).run(userId);

    // d. Clear active workspace pointer
    db.prepare('DELETE FROM user_active_workspace WHERE user_id = ?').run(userId);

    // e. Clear orphaned connections (Composio, etc.)
    db.prepare("DELETE FROM connections WHERE owner_id = ? AND owner_kind = 'user'").run(userId);

    // f. ADR-011: hard account deletion removes the user's run rows.
    deleteRunsForUserAccount(userId);

    // g. Finally, delete user from Floom's mirror table
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    // 3. Process workspaces where user was a member
    for (const { workspace_id } of memberships) {
      if (workspace_id === DEFAULT_WORKSPACE_ID) continue;

      const memberCount = db
        .prepare('SELECT COUNT(*) as c FROM workspace_members WHERE workspace_id = ?')
        .get(workspace_id) as { c: number };

      if (memberCount.c === 0) {
        // Last member, cleanup workspace and its non-public assets

        // a. Delete per-app secrets
        db.prepare(`
          DELETE FROM secrets 
          WHERE app_id IN (
            SELECT id FROM apps 
            WHERE workspace_id = ? 
              AND visibility != 'public'
          )
        `).run(workspace_id);

        // b. Delete private apps (runs, jobs, etc. follow via CASCADE)
        db.prepare(`
          DELETE FROM apps 
          WHERE workspace_id = ? 
            AND visibility != 'public'
        `).run(workspace_id);

        // c. Retain public apps: move to 'local' and clear author
        db.prepare(`
          UPDATE apps 
             SET workspace_id = ?,
                 author = NULL,
                 updated_at = datetime('now')
           WHERE workspace_id = ? 
             AND (visibility = 'public' OR visibility IS NULL)
        `).run(DEFAULT_WORKSPACE_ID, workspace_id);

        // d. Clean up workspace-scoped tables lacking FK CASCADE
        db.prepare('DELETE FROM run_threads WHERE workspace_id = ?').run(workspace_id);
        db.prepare('DELETE FROM app_reviews WHERE workspace_id = ?').run(workspace_id);
        db.prepare('DELETE FROM feedback WHERE workspace_id = ?').run(workspace_id);

        // e. Finally, delete the workspace itself
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace_id);
      }
    }
  });

  runCleanup();

  // Perf fix (2026-04-20): bust the /api/hub 5s cache so dropped /
  // reassigned public apps land in the directory immediately after the
  // cleanup transaction commits.
  invalidateHubCache();
}
