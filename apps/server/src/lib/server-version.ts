import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** `version` from apps/server/package.json — single source for /api/health and /openapi.json. */
export const SERVER_VERSION = (require('../../package.json') as { version: string }).version;
