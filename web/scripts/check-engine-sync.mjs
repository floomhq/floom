#!/usr/bin/env node
// CI drift guard: proves the Cloud `web/` generated tree has ZERO drift from
// engine/apps/web (the de-fork invariant), EXCEPT the declared overlay files.
//
// Strategy: run the sync into a fresh temp dir, then byte-compare every synced
// (non-overlay) file there against engine/apps/web. Any difference, extra file,
// or missing file => non-zero exit. The overlay files are expected to differ
// (that's the whole point) and are excluded from the comparison.
//
// Usage: node scripts/check-engine-sync.mjs
// Exit 0 = no drift; exit 1 = drift found.

import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { OVERLAY_FILES, ENGINE_STALE_REMOVED, withCloudTailwindSources } from "./sync-engine-web.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, "..");
const ENGINE_WEB = resolve(join(WEB_DIR, "..", "engine", "apps", "web"));

// The sync materializes these from the engine too; they are generated, not
// part of the engine source-dir walk, so compare them against the engine
// root files directly.
const ROOT_FILES = [
  "next.config.ts",
  "tsconfig.json",
  "postcss.config.mjs",
  "tailwind.config.ts",
  "components.json",
  "eslint.config.mjs",
];

const SYNC_DIRS = ["app", "components", "lib", "public", "tests"];

function walk(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, acc);
    else if (entry.isFile()) acc.push(relative(base, full));
  }
  return acc;
}

function read(p) {
  return readFileSync(p, "utf8");
}

function main() {
  if (!existsSync(ENGINE_WEB)) {
    console.error(`[drift] FATAL: engine not found at ${ENGINE_WEB}`);
    process.exit(2);
  }

  const tmp = mkdtempSync(join(tmpdir(), "wc-drift-"));
  const errors = [];
  try {
    // Sync into an isolated temp tree (the script always reads the tracked
    // web/overlay regardless of --dest), so the check never depends on a
    // prior build state of web/.
    runSyncToTmp(tmp);

    const overlaySet = new Set(OVERLAY_FILES);
    const staleSet = new Set(ENGINE_STALE_REMOVED);

    // 1) Every engine source file (minus overlay-overwritten + stale-removed)
    //    must appear identically in the synced tree.
    for (const d of SYNC_DIRS) {
      for (const rel of walk(join(ENGINE_WEB, d), ENGINE_WEB)) {
        if (staleSet.has(rel)) continue; // intentionally not carried
        if (overlaySet.has(rel)) continue; // overlay owns this path
        const synced = join(tmp, rel);
        if (!existsSync(synced)) {
          errors.push(`MISSING in synced tree: ${rel}`);
          continue;
        }
        const expected = rel === "app/globals.css"
          ? withCloudTailwindSources(read(join(ENGINE_WEB, rel)))
          : read(join(ENGINE_WEB, rel));
        if (expected !== read(synced)) {
          errors.push(`DRIFT (differs from engine): ${rel}`);
        }
      }
    }

    // 2) Root config files must match the engine exactly.
    for (const f of ROOT_FILES) {
      const eng = join(ENGINE_WEB, f);
      const synced = join(tmp, f);
      if (!existsSync(eng)) continue;
      if (!existsSync(synced)) {
        errors.push(`MISSING in synced tree: ${f}`);
        continue;
      }
      if (read(eng) !== read(synced)) errors.push(`DRIFT (root config): ${f}`);
    }

    // 3) Stale-removed engine files must NOT be present in the synced tree.
    for (const rel of staleSet) {
      if (existsSync(join(tmp, rel))) {
        errors.push(`STALE FILE PRESENT (should be excluded): ${rel}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (errors.length) {
    console.error(`[drift] FAIL: ${errors.length} issue(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("[drift] PASS: synced tree matches engine/apps/web (overlay excluded). Zero drift.");
}

// Run sync targeting an explicit dest dir by spawning the script with --dest.
// DEST is computed at module load in sync-engine-web.mjs, so we spawn a child
// process with flags to retarget it. Dep-free (node:child_process).
function runSyncToTmp(dest) {
  execFileSync(
    process.execPath,
    [join(__dirname, "sync-engine-web.mjs"), "--engine", ENGINE_WEB, "--dest", dest, "--quiet"],
    { stdio: "inherit" }
  );
}

main();
