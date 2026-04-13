/**
 * Tiny helper to load the E2B_API_KEY from the known env file locations.
 *
 * Order of precedence:
 *   1. Existing process.env.E2B_API_KEY (set by the caller)
 *   2. /opt/floom-marketplace-deploy/.env (the deployment env file)
 *   3. /opt/floom-e2b-runtime/.env (local override, if present)
 *
 * Pure stdlib, no `dotenv` dependency.
 */
import * as fs from 'node:fs';

const CANDIDATE_FILES = [
  '/opt/floom-marketplace-deploy/.env',
  '/opt/floom-e2b-runtime/.env',
];

export function loadEnvKey(): string {
  if (process.env.E2B_API_KEY) return process.env.E2B_API_KEY;

  for (const file of CANDIDATE_FILES) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const match = content.match(/^E2B_API_KEY=(.+)$/m);
      if (match && match[1]) {
        process.env.E2B_API_KEY = match[1].trim();
        return process.env.E2B_API_KEY;
      }
    } catch {
      // file missing, keep looking
    }
  }

  throw new Error(
    'E2B_API_KEY not set and no .env file found. Set E2B_API_KEY or create /opt/floom-e2b-runtime/.env.',
  );
}
