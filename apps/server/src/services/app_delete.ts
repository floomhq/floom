// Central app row removal for creator flows. Hard-delete: there is no
// apps.deleted_at column; FKs (runs, app_creator_secrets, triggers, …)
// use ON DELETE CASCADE from db.ts.
import { db } from '../db.js';
import { invalidateHubCache } from '../lib/hub-cache.js';

export function deleteAppRecordById(appId: string): void {
  db.prepare('DELETE FROM apps WHERE id = ?').run(appId);
  invalidateHubCache();
}
