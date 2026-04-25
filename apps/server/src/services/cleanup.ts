import { storage } from './storage.js';
import { DEFAULT_WORKSPACE_ID } from '../db.js';
import { invalidateHubCache } from '../lib/hub-cache.js';

/**
 * Cleanup orphaned Floom data when a user is deleted from Better Auth.
 * 
 * Logic delegated to storage adapter.
 */
export function cleanupUserOrphans(userId: string): void {
  storage.cleanupUserOrphans(userId, DEFAULT_WORKSPACE_ID);
  
  // Perf fix (2026-04-20): bust the /api/hub 5s cache so dropped /
  // reassigned public apps land in the directory immediately after the
  // cleanup transaction commits.
  invalidateHubCache();
}
