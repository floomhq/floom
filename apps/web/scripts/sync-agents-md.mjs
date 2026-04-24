#!/usr/bin/env node
// Sync canonical root/public helper files into apps/web/public/ so Vite
// copies them to dist/ and the server can serve them directly.
//
// Launch-audit 2026-04-24 (P0-4): "for a protocol for agentic work,
// agent-readable docs are table stakes." Shipping /AGENTS.md as a
// real text/markdown file lets any agent curl the docs without running
// JS. Keeping the root AGENTS.md as the canonical source + syncing on
// build prevents drift.
//
// Launch-audit 2026-04-24 (P0-6): the published CLI install command uses
// https://floom.dev/install.sh. Sync the canonical cli/floom/install.sh
// into apps/web/public/install.sh so the hosted URL serves a real script
// instead of the SPA shell.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const copies = [
  {
    label: 'sync-agents-md',
    src: resolve(root, 'AGENTS.md'),
    dest: resolve(here, '..', 'public', 'AGENTS.md'),
  },
  {
    label: 'sync-install-sh',
    src: resolve(root, 'cli', 'floom', 'install.sh'),
    dest: resolve(here, '..', 'public', 'install.sh'),
  },
];

for (const copy of copies) {
  let content;
  try {
    content = readFileSync(copy.src, 'utf-8');
  } catch (err) {
    console.error(`[${copy.label}] could not read ${copy.src}: ${err.message}`);
    process.exit(1);
  }

  mkdirSync(dirname(copy.dest), { recursive: true });
  writeFileSync(copy.dest, content);
  console.log(`[${copy.label}] copied ${copy.src} -> ${copy.dest} (${content.length} bytes)`);
}
