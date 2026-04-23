// Adapter bundle — module-level singleton.
//
// Lives in its own file (not src/index.ts) so route modules can
// `import { adapters } from '../adapters/index.js'` without creating an
// import cycle with the server bootstrap.
//
// Instantiated once at first import. createAdapters() reads env vars
// (FLOOM_RUNTIME / FLOOM_STORAGE / FLOOM_AUTH / FLOOM_SECRETS /
// FLOOM_OBSERVABILITY) and throws on unknown values, so a typo surfaces
// at boot instead of on the first request.

import { createAdapters } from './factory.js';

export const adapters = createAdapters();

export type { AdapterBundle } from './factory.js';
