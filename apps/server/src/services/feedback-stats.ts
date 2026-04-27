import { db } from '../db.js';

// Product-feedback triage is Floom Cloud operational data, not protocol
// storage. Keep it isolated from run lifecycle routing.
export function listFeedbackUrls(): Array<{ url: string | null }> {
  return db
    .prepare('SELECT url FROM feedback ORDER BY created_at DESC')
    .all() as Array<{ url: string | null }>;
}
