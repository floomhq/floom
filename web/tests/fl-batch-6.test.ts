/**
 * Cloud install-routing guard (reduced from the engine's fl-batch-6 batch).
 *
 * This overlay shadows engine/apps/web/tests/fl-batch-6.test.ts. All of that
 * batch's assertions either duplicate engine coverage (#536 FilesEditor, #540
 * SlackConnect, #561 RunDetailSplitPane) or went stale against the current
 * engine (#539 split the worker-detail nav into a redirect stub + Workers
 * Collection, so PRIMARY_NAV/SETUP_NAV no longer live in workers/[id]/page).
 * The engine versions run in the engine's own CI; re-asserting them here is
 * exactly the redundant fork the cloud de-fork removes.
 *
 * What is NOT covered upstream is the ONE cloud seam (#552): the cloud login
 * page routes a post-sign-in `?install=<channel>` through the cloud-only
 * `/app/install/<channel>` handoff page (basePath `/app`), whereas the engine
 * login routes to `/settings?from_install=<channel>`. The engine ships no
 * app/install directory, so its fl-batch-6 cannot guard this. Keep only that.
 *
 * Run: npx tsx tests/fl-batch-6.test.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function src(rel: string) { return readFileSync(resolve(ROOT, rel), "utf8"); }

// #552 — the cloud login page reads ?install and routes through the cloud-only
// /app/install/<channel> handoff page (the genuine cloud onboarding+basePath seam).
function test552LoginRoutesInstallThroughCloudHandoff(): void {
  const s = src("app/login/page.tsx");
  assert(s.includes("install"), "Login page must read the ?install query param");
  assert(s.includes("INSTALL_ROUTES"), "Login must define a channel → route mapping");
  assert(s.includes("/app/install/slack"), "Slack install must route through the cloud install handoff page");
}

const tests: [string, () => void][] = [
  ["#552 cloud login routes ?install through /app/install/<channel>", test552LoginRoutesInstallThroughCloudHandoff],
];

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
    failed++;
  }
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
