import { SQLiteStorageAdapter } from '../adapters/sqlite-storage.js';

/**
 * Singleton repository instance for Floom's core data models.
 * Used by the control plane routes to read/write state without direct
 * SQL coupling.
 */
export const storage = new SQLiteStorageAdapter();
