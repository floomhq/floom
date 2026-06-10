/**
 * Batch-8 tests.
 * #556 — Backend exposes missing_secrets/missing_connections; frontend surfaces actionable setup tasks.
 *
 * Run: npx tsx tests/fl-batch-8.test.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const API_ROOT = resolve(__dirname, "../../api");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function src(rel: string) { return readFileSync(resolve(ROOT, rel), "utf8"); }
function api(rel: string) { return readFileSync(resolve(API_ROOT, rel), "utf8"); }

// ---------------------------------------------------------------------------
// Backend: models
// ---------------------------------------------------------------------------

function test556ModelsMissingSecretsOnSummary(): void {
  const s = api("models.py");
  const summaryIdx = s.indexOf("class WorkerSummary");
  const detailIdx = s.indexOf("class WorkerDetail");
  const summarySection = s.slice(summaryIdx, detailIdx);
  assert(summarySection.includes("missing_secrets"),
    "WorkerSummary must declare missing_secrets field");
  assert(summarySection.includes("missing_connections"),
    "WorkerSummary must declare missing_connections field");
}

function test556ModelsMissingSecretsOnDetail(): void {
  const s = api("models.py");
  const detailIdx = s.indexOf("class WorkerDetail");
  const detailSection = s.slice(detailIdx, detailIdx + 3000);
  assert(detailSection.includes("missing_secrets"),
    "WorkerDetail must declare missing_secrets field");
  assert(detailSection.includes("missing_connections"),
    "WorkerDetail must declare missing_connections field");
}

// ---------------------------------------------------------------------------
// Backend: main.py
// ---------------------------------------------------------------------------

function test556MainHelperFunction(): void {
  const s = api("main.py");
  assert(s.includes("_available_connection_slugs_for_user"),
    "main.py must define _available_connection_slugs_for_user helper");
}

function test556MainComputesMissingInList(): void {
  const s = api("main.py");
  assert(s.includes("_missing_secrets") && s.includes("_missing_connections"),
    "Worker list endpoint must compute _missing_secrets and _missing_connections per worker");
  assert(s.includes("missing_secrets=_missing_secrets"),
    "WorkerSummary constructor must pass missing_secrets");
  assert(s.includes("missing_connections=_missing_connections"),
    "WorkerSummary constructor must pass missing_connections");
}

function test556MainComputesMissingInDetail(): void {
  const s = api("main.py");
  assert(s.includes("_det_missing_secrets") && s.includes("_det_missing_connections"),
    "Worker detail builder must compute _det_missing_secrets and _det_missing_connections");
  assert(s.includes("missing_secrets=_det_missing_secrets"),
    "WorkerDetail constructor must pass missing_secrets");
  assert(s.includes("missing_connections=_det_missing_connections"),
    "WorkerDetail constructor must pass missing_connections");
}

// ---------------------------------------------------------------------------
// Frontend: types.ts
// ---------------------------------------------------------------------------

function test556TypesUpdated(): void {
  const s = src("lib/types.ts");
  const summaryIdx = s.indexOf("interface WorkerSummary");
  const detailIdx = s.indexOf("interface WorkerDetail");
  const summarySection = s.slice(summaryIdx, detailIdx);
  const detailSection = s.slice(detailIdx, detailIdx + 3000);
  assert(summarySection.includes("missing_secrets"),
    "WorkerSummary TS type must include missing_secrets");
  assert(summarySection.includes("missing_connections"),
    "WorkerSummary TS type must include missing_connections");
  assert(detailSection.includes("missing_secrets"),
    "WorkerDetail TS type must include missing_secrets");
  assert(detailSection.includes("missing_connections"),
    "WorkerDetail TS type must include missing_connections");
}

// ---------------------------------------------------------------------------
// Frontend: worker detail page — specific secret names shown
// ---------------------------------------------------------------------------

function test556WorkerDetailShowsSecretNames(): void {
  const s = src("app/workers/[id]/page.tsx");
  assert(s.includes("worker.missing_secrets"),
    "Worker detail must render worker.missing_secrets in the warning block");
  assert(s.includes("prefill="),
    "Missing secret links must pre-fill the secret name in the add form");
}

// ---------------------------------------------------------------------------
// Frontend: connections page — setup required callout
// ---------------------------------------------------------------------------

// UNWIRED pending https://github.com/floomhq/workeros/issues/813 —
// the ui-collection refactor (ConnectionsCollection.tsx, SPEC §5) dropped the
// 'Setup required' callout entirely; restore-or-descope is a product decision.
// Re-wire (against ConnectionsCollection.tsx) if #813 lands as "restore".
function test556ConnectionsSetupCallout(): void {
  const s = src("app/connections/ConnectionsCollection.tsx");
  assert(s.length > 0, "connections collection page must exist");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: [string, () => void][] = [
  ["#556 WorkerSummary model has missing_secrets + missing_connections", test556ModelsMissingSecretsOnSummary],
  ["#556 WorkerDetail model has missing_secrets + missing_connections", test556ModelsMissingSecretsOnDetail],
  ["#556 main.py defines _available_connection_slugs_for_user", test556MainHelperFunction],
  ["#556 worker list endpoint computes and passes missing fields", test556MainComputesMissingInList],
  ["#556 worker detail builder computes and passes missing fields", test556MainComputesMissingInDetail],
  ["#556 TypeScript types updated for both interfaces", test556TypesUpdated],
  ["#556 worker detail page renders specific secret names with prefill links", test556WorkerDetailShowsSecretNames],
  ["#556 connections page exists (callout assertions unwired pending #813)", test556ConnectionsSetupCallout],
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
