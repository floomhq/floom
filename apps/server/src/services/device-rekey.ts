import { db, DEFAULT_USER_ID } from '../db.js';
import type { RekeyResult } from '../types.js';

/**
 * Atomically re-key a device_id to a user_id across app_memory, runs,
 * run_threads, and connections. Returns the row counts. Runs inside a
 * single SQLite transaction so partial re-keys are impossible. Idempotent:
 * already-claimed rows are filtered out by the WHERE clauses.
 *
 * Connections table (W2.3): anonymous rows use owner_kind='device' +
 * owner_id=<device_id>. Re-key flips them to owner_kind='user' +
 * owner_id=<user_id>. The Composio-side `composio_account_id` is not
 * rewritten; the legacy Composio user id is persisted on
 * `users.composio_user_id` for future lookups.
 */
export function rekeyDevice(
  device_id: string,
  user_id: string,
  workspace_id: string,
): RekeyResult {
  if (!device_id || !user_id || !workspace_id) {
    throw new Error('rekeyDevice: device_id, user_id, workspace_id are required');
  }

  const result: RekeyResult = {
    app_memory: 0,
    runs: 0,
    run_threads: 0,
    connections: 0,
  };

  const run = db.transaction(() => {
    const memRes = db
      .prepare(
        `UPDATE app_memory
           SET user_id = ?,
               workspace_id = ?,
               updated_at = datetime('now')
         WHERE device_id = ?
           AND user_id = ?`,
      )
      .run(user_id, workspace_id, device_id, DEFAULT_USER_ID);
    result.app_memory = memRes.changes;

    const runRes = db
      .prepare(
        `UPDATE runs
           SET user_id = ?,
               workspace_id = ?
         WHERE device_id = ?
           AND (user_id IS NULL OR user_id = ?)`,
      )
      .run(user_id, workspace_id, device_id, DEFAULT_USER_ID);
    result.runs = runRes.changes;

    const threadRes = db
      .prepare(
        `UPDATE run_threads
           SET user_id = ?,
               workspace_id = ?,
               updated_at = datetime('now')
         WHERE device_id = ?
           AND (user_id IS NULL OR user_id = ?)`,
      )
      .run(user_id, workspace_id, device_id, DEFAULT_USER_ID);
    result.run_threads = threadRes.changes;

    const conRes = db
      .prepare(
        `UPDATE connections
           SET owner_kind = 'user',
               owner_id = ?,
               workspace_id = ?,
               updated_at = datetime('now')
         WHERE owner_kind = 'device'
           AND owner_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM connections c2
              WHERE c2.workspace_id = ?
                AND c2.owner_kind = 'user'
                AND c2.owner_id = ?
                AND c2.provider = connections.provider
           )`,
      )
      .run(user_id, workspace_id, device_id, workspace_id, user_id);
    result.connections = conRes.changes;

    if (result.connections > 0) {
      db.prepare(
        `UPDATE users
           SET composio_user_id = COALESCE(composio_user_id, ?)
         WHERE id = ?`,
      ).run(`device:${device_id}`, user_id);
    }
  });

  run();
  return result;
}
