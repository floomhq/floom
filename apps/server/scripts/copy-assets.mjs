#!/usr/bin/env node
// Copy non-TS assets from src/ to dist/ after tsc runs.
// - src/lib/entrypoint.py   → dist/lib/entrypoint.py
// - src/lib/entrypoint.mjs  → dist/lib/entrypoint.mjs
// - src/db/seed.json        → dist/db/seed.json
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');

const targets = [
  ['src/lib/entrypoint.py', 'dist/lib/entrypoint.py'],
  ['src/lib/entrypoint.mjs', 'dist/lib/entrypoint.mjs'],
  ['src/db/seed.json', 'dist/db/seed.json'],
];

for (const [src, dst] of targets) {
  const from = join(serverRoot, src);
  const to = join(serverRoot, dst);
  if (!existsSync(from)) {
    console.warn(`[copy-assets] missing: ${src}`);
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`[copy-assets] ${src} → ${dst}`);
}
