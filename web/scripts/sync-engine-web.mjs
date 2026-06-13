#!/usr/bin/env node
// Deterministic build-time sync: copy the engine's apps/web into this Cloud
// `web/` tree, then layer the Cloud overlay on top. The synced tree is
// generated (gitignored); only `overlay/`, `package.json`, config, and these
// scripts are tracked. This is the "de-fork": the dashboard equals
// engine/apps/web EXCEPT the small Cloud overlay, and STAYS equal via a
// submodule bump. No deps; Node built-ins only.
//
// Run from `web/` (Vercel rootDirectory=web/, runs `npm run build`):
//   node scripts/sync-engine-web.mjs && next build
//
// Also usable from anywhere via --engine / --dest flags (the drift guard
// uses these to sync into a temp dir).

import { existsSync, mkdirSync, readdirSync, rmSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ lives under web/, so web/ is one level up.
const WEB_DIR = resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--engine") out.engine = argv[++i];
    else if (a === "--dest") out.dest = argv[++i];
    else if (a === "--quiet") out.quiet = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// Engine apps/web source. Default: ../engine/apps/web relative to web/.
const ENGINE_WEB = resolve(args.engine || join(WEB_DIR, "..", "engine", "apps", "web"));
// Destination generated tree. Default: web/ itself.
const DEST = resolve(args.dest || WEB_DIR);
// Overlay always lives in the real web/overlay (tracked), regardless of dest.
const OVERLAY = join(WEB_DIR, "overlay");

const log = (...m) => {
  if (!args.quiet) console.log(...m);
};

// Top-level entries copied from the engine into the generated tree. Source
// dirs + the engine's root config/source files. We deliberately do NOT copy
// the engine's package.json / lockfiles (the Cloud `web/package.json` is the
// tracked source of truth for deps + the sync-first build script) or
// node_modules / .next / .git.
const COPY_DIRS = ["app", "components", "lib", "public", "tests"];
const COPY_ROOT_FILES = [
  "next.config.ts",
  "tsconfig.json",
  "postcss.config.mjs",
  "tailwind.config.ts",
  "components.json",
  "eslint.config.mjs",
];

// Overlay files (relative to overlay/ and to the generated tree). Listed
// explicitly so the drift guard knows exactly which paths to exclude from
// the "must equal engine" check. Keep in sync with overlay/ contents.
export const OVERLAY_FILES = [
  "app/api/auth/email/route.ts",
  "app/api/auth/password/route.ts",
  "app/api/proxy/[...path]/route.ts",
  "app/s/[token]/download/route.ts",
  // app/contexts/page.tsx + app/assistant/page.tsx de-forked 2026-06-13: both were
  // stale forks that lagged the engine (no cloud seam; the engine pages are strict
  // supersets — Brain share-link/restore-by-SHA, and the Emily base-persona model).
  "app/cloud-shell.css",
  "app/layout.tsx",
  "app/login/page.tsx",
  "app/install/[channel]/page.tsx",
  "app/invite/[token]/page.tsx",
  "app/api/me/route.ts",
  "app/api/cli-auth/[action]/route.ts",
  "app/cli-auth/page.tsx",
  "app/connections/connected-accounts/[id]/route.ts",
  // app/page.tsx de-forked 2026-06-13: was a bare redirect("/overview"); the engine
  // root page renders the overview dashboard at "/" directly (engine serves it at
  // both "/" and "/overview"), so the redirect was redundant.
  "app/privacy/page.tsx",
  // app/settings/page.tsx de-forked 2026-06-13: the overlay copy was a stale
  // subset (1063 vs engine 2223 lines) missing WorkspaceTokensPanel /
  // BehaviourSettings / ModelDefaults / WorkspaceInfoSettings. The engine
  // settings page is fully cloud-compatible (all API calls go through lib/api ->
  // cloud proxy + workspace headers; its WhatsApp QR uses the same +1 650-399-9709
  // number the overlay hardcoded). Engine settings flows through unmodified.
  "app/settings/members/page.tsx",
  "app/join/page.tsx",
  "app/members/page.tsx",
  "app/workers/page.tsx",
  "app/workers/WorkersClient.tsx",
  // app/runs/RunsClient.tsx de-forked 2026-06-13: dead orphan. The engine renamed
  // RunsClient -> RunsCollection; runs/page.tsx (pure engine) renders RunsCollection
  // and nothing imports RunsClient. (trigger_member_email attribution belongs upstream.)
  "app/workers/[id]/share/page.tsx",
  "app/workspace/share/[token]/page.tsx",
  "components/CloudAppChrome.tsx",
  "components/VersionHistoryMenu.tsx",
  "components/TelemetryProvider.tsx",
  "components/layout/WorkspaceSwitcher.tsx",
  "components/layout/sidebar.tsx",
  // components/ui/dropdown-menu.tsx de-forked 2026-06-13: cosmetic Tailwind drift only
  // (engine uses the current design tokens) — no cloud seam.
  // components/CliCommandPanel.tsx de-forked 2026-06-13: dead code (nothing renders it).
  // The PAT/token UI is now the engine settings page's PersonalAccessTokensPanel +
  // WorkspaceTokensPanel, which flow through after the 2026-06-13 settings de-fork.
  "middleware.ts",
  "tests/cloud-invite-install.test.ts",
  "tests/fl-batch-6.test.ts",
  "lib/server-api.ts",
  // lib/api.ts de-forked 2026-06-12: the engine version consumes the cloud env
  // seams (NEXT_PUBLIC_API_PROXY_BASE / NEXT_PUBLIC_BASE_PATH) directly; the
  // overlay copy had silently fallen behind (missing workspace.getSettings,
  // bulk export, chat attachments) and broke those features on cloud.
  // lib/types.ts entry was stale — the overlay file never existed.
  "lib/telemetry.ts",
  // lib/useRunStream.ts de-forked 2026-06-13: the engine hook is identical-shaped and a
  // strict superset; the workspace-query seam lives in lib/api's apiProxyPath, not here.
  "lib/verify-session.ts",
  "tests/verify-session-935.test.ts",
  "tests/me-cache-941.test.ts",
  "tests/csrf-origin-947.test.ts",
];

const CLOUD_TAILWIND_SOURCE_MARKER = "/* workeros-cloud generated Tailwind sources */";

export function withCloudTailwindSources(css) {
  if (css.includes(CLOUD_TAILWIND_SOURCE_MARKER)) return css;
  const insert = [
    CLOUD_TAILWIND_SOURCE_MARKER,
    "@source \"../app\";",
    "@source \"../components\";",
    "@source \"../lib\";",
    "",
  ].join("\n");
  return css.replace('@import "tailwindcss";', `@import "tailwindcss";\n${insert}`);
}

// Files that exist in the engine tree but must NOT be carried into the Cloud
// generated tree (stale forks the engine has since removed). The engine
// next.config.ts redirects /workers/:id/edit -> /workers/:id?edit=1, so the
// edit page is gone upstream; never resurrect it.
const ENGINE_STALE_REMOVED = ["app/workers/[id]/edit/page.tsx"];

function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, acc);
    } else if (entry.isFile()) {
      acc.push(relative(base, full));
    }
  }
  return acc;
}

function copyInto(srcRoot, relPath, destRoot) {
  const src = join(srcRoot, relPath);
  const dst = join(destRoot, relPath);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

function rmIfExists(p) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

// Public build seams the synced engine tree needs:
//   NEXT_PUBLIC_BASE_PATH=/app, NEXT_PUBLIC_API_PROXY_BASE=/app/api/proxy
// These are NOT written to any file (no .env.local) — they are passed inline
// by the package.json build/dev scripts and set in the Vercel project env for
// production. Avoiding an env file keeps the generated tree free of any
// committed/regenerated secrets-adjacent artifact.

function main() {
  if (!existsSync(ENGINE_WEB)) {
    // Deploy context: the dashboard is deployed via `vercel deploy` from `web/`
    // (project rootDirectory=null, CLI uploads only web/), so the root-level
    // `engine/` submodule is NOT present in the build container. That's fine —
    // the tree was synced locally BEFORE deploy and uploaded with web/. Skip
    // gracefully if a pre-synced tree exists; only fail if there's nothing to
    // build (genuinely broken local run with no engine and no synced tree).
    const preSynced =
      DEST === WEB_DIR &&
      existsSync(join(DEST, "app")) &&
      existsSync(join(DEST, "components", "layout", "sidebar.tsx"));
    if (preSynced) {
      log(
        `[sync] engine source absent at ${ENGINE_WEB}; using pre-synced tree ` +
          `(deploy context). Skipping sync.`
      );
      return;
    }
    console.error(
      `[sync] FATAL: engine source not found at ${ENGINE_WEB} and no pre-synced ` +
        `tree present.\n` +
        `       Locally, init the submodule: git submodule update --init --recursive\n` +
        `       For deploy, run \`npm run sync\` before \`vercel deploy\`.`
    );
    process.exit(1);
  }
  log(`[sync] engine source: ${ENGINE_WEB}`);
  log(`[sync] dest tree:     ${DEST}`);
  log(`[sync] overlay:       ${OVERLAY}`);

  let copied = 0;
  let overlaid = 0;
  let skippedStale = 0;

  // 1) Wipe the generated dirs in dest so removed engine files don't linger
  //    (idempotent + deterministic: dest dirs mirror engine exactly).
  for (const d of COPY_DIRS) {
    rmIfExists(join(DEST, d));
  }

  // 2) Copy engine source dirs.
  for (const d of COPY_DIRS) {
    const srcDir = join(ENGINE_WEB, d);
    if (!existsSync(srcDir)) continue;
    for (const rel of walk(srcDir, ENGINE_WEB)) {
      if (ENGINE_STALE_REMOVED.includes(rel)) {
        skippedStale++;
        continue;
      }
      copyInto(ENGINE_WEB, rel, DEST);
      copied++;
    }
  }

  // 3) Copy engine root config/source files.
  for (const f of COPY_ROOT_FILES) {
    if (existsSync(join(ENGINE_WEB, f))) {
      copyInto(ENGINE_WEB, f, DEST);
      copied++;
    }
  }

  // 4) Preserve the engine sidebar's exported parts under a stable companion
  //    name so the overlay sidebar can compose them. The overlay then
  //    overwrites the default sidebar.tsx. Without this, the overlay would
  //    have to import from a file it is about to replace.
  const engineSidebar = "components/layout/sidebar.tsx";
  if (existsSync(join(ENGINE_WEB, engineSidebar))) {
    const companion = "components/layout/sidebar.engine.tsx";
    copyInto(ENGINE_WEB, engineSidebar, DEST);
    // rename copy -> .engine.tsx
    const from = join(DEST, engineSidebar);
    const to = join(DEST, companion);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied++;
    log(`[sync] preserved engine sidebar exports -> ${companion}`);
  }

  // 4b) Preserve cloud-overridden engine components under stable companion names
  //     so overlay files can compose from them and the drift guard has a reference.
  for (const [src, companion] of [
    ["app/workers/WorkersClient.tsx", "app/workers/WorkersClient.engine.tsx"],
  ]) {
    if (existsSync(join(ENGINE_WEB, src))) {
      const from = join(DEST, src); // already copied in step 2
      const to = join(DEST, companion);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied++;
      log(`[sync] preserved engine ${src} -> ${companion}`);
    }
  }

  // 5) Layer the overlay on top (overwrites synced engine files).
  if (existsSync(OVERLAY)) {
    for (const rel of walk(OVERLAY)) {
      copyInto(OVERLAY, rel, DEST);
      overlaid++;
      log(`[sync]   overlay: ${rel}`);
    }
  }

  // 6) Tailwind v4 auto source detection ignores .gitignore entries. In Cloud,
  // app/components/lib are generated and intentionally gitignored, so Vercel's
  // builder otherwise scans only the small tracked overlay and drops most app
  // utilities (grid-cols, responsive variants, etc.). Keep globals.css equal to
  // the engine source plus explicit generated-source directives.
  const globalsPath = join(DEST, "app", "globals.css");
  if (existsSync(globalsPath)) {
    writeFileSync(globalsPath, withCloudTailwindSources(readFileSync(globalsPath, "utf8")));
  }

  log(
    `[sync] done: ${copied} engine files copied, ${overlaid} overlay files layered, ${skippedStale} stale engine file(s) skipped.`
  );
}

// Only run when invoked directly (so the drift guard can import OVERLAY_FILES
// without triggering a sync).
if (resolve(process.argv[1] || "") === resolve(fileURLToPath(import.meta.url))) {
  main();
}

export { main as syncEngineWeb, ENGINE_STALE_REMOVED, COPY_DIRS, COPY_ROOT_FILES };
