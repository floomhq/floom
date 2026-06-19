#!/usr/bin/env node
/**
 * lint-tokens.mjs
 *
 * Guards against retired warm-palette hex values leaking back into the
 * apps/web source tree.  The ONLY allowed location for these literals is
 * apps/web/app/globals.css (the canonical token-definition file).
 *
 * Fails with exit 1 and prints each offending file:line when a retired hex
 * is found anywhere else.
 *
 * Retired warm hex values (superseded by v4 cool palette — see #1330/#1331):
 *   #FAFAF7  #F1EEE8  #141414  #6B6861  #E7E0D6  #E8E3DA
 *
 * Usage:
 *   node scripts/lint-tokens.mjs
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

// Retired warm hex values — case-insensitive match
const RETIRED_HEX = [
  '#FAFAF7',
  '#F1EEE8',
  '#141414',
  '#6B6861',
  '#E7E0D6',
  '#E8E3DA',
];

// The one file allowed to contain these as token definitions
const ALLOWED_FILE = join(ROOT, 'app', 'globals.css');

const PATTERN = new RegExp(RETIRED_HEX.join('|'), 'gi');

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.css']);

/** Recursively collect files with the target extensions under `dir`. */
function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // Skip node_modules and .next build output
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, files);
    } else if (SCAN_EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) {
      files.push(full);
    }
  }
  return files;
}

const files = collectFiles(ROOT);

const violations = [];

for (const filePath of files) {
  if (filePath === ALLOWED_FILE) continue;

  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (PATTERN.test(lines[i])) {
      violations.push(`${relative(ROOT, filePath)}:${i + 1}: ${lines[i].trim()}`);
    }
    // Reset lastIndex after global regex test
    PATTERN.lastIndex = 0;
  }
}

if (violations.length > 0) {
  console.error(
    `\nlint-tokens: ${violations.length} retired warm-palette hex value(s) found.\n` +
    `Replace with the matching CSS token (var(--bg-app), var(--border-default), etc.)\n` +
    `or the cool-palette value. See apps/web/app/globals.css :root for the token map.\n`
  );
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error('');
  process.exit(1);
}

console.log(`lint-tokens: OK — no retired warm-palette hex values found outside globals.css`);
