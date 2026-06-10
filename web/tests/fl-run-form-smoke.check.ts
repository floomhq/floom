/**
 * Run-form/manual smoke regression tests.
 * #668 — required inputs are validated before creating a run.
 * #689 — no-input workers expose Run without requiring sample-fill.
 * #690 — worker detail treats active/valid/connected app connections as runnable.
 * #691 — stock file-upload samples contain inline file content and synthesize uploads.
 *
 * Run: npx tsx tests/fl-run-form-smoke.check.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(ROOT, "../..");
const WORKER_PAGE = resolve(ROOT, "app/workers/[id]/page.tsx");
const TYPES = resolve(ROOT, "lib/types.ts");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

function test668RequiredInputsGateRun(): void {
  const src = readFileSync(WORKER_PAGE, "utf8");
  assert(src.includes("function requiredRunInputErrors"), "worker page must define required run input validation");
  assert(
    src.includes("Object.keys(inputValidationErrors).length === 0"),
    "canRun must require all required inputs to be filled",
  );
  const handleRun = src.slice(src.indexOf("async function handleRun"), src.indexOf("const loadActiveRun"));
  assert(
    handleRun.includes("requiredRunInputErrors(worker.config.inputs, inputs)") &&
      handleRun.includes("Fill required inputs before running") &&
      handleRun.indexOf("requiredRunInputErrors") < handleRun.indexOf("api.workers.run"),
    "handleRun must validate required inputs before api.workers.run",
  );
  assert(src.includes("validationErrors[inp.name]"), "RunSection must render inline validation errors per field");
}

function test689NoInputWorkersCanRunWithoutSample(): void {
  const src = readFileSync(WORKER_PAGE, "utf8");
  assert(
    src.includes("const canApplySample = worker.config.inputs.length > 0"),
    "sample-fill button must only depend on declared inputs",
  );
  assert(
    src.includes("worker.config.inputs.length === 0") && src.includes("This worker has no inputs."),
    "Run tab must explicitly handle zero-input workers",
  );
  const nodeInput = read("docs/workers/inputs/node-smoke-test.json");
  assert(nodeInput.includes("No inputs required"), "node-smoke-test smoke input must document no-input behavior");
}

function test690ConnectionGateUsesBackendLiveStatuses(): void {
  const src = readFileSync(WORKER_PAGE, "utf8");
  assert(
    src.includes('LIVE_CONNECTION_STATUSES = new Set(["active", "valid", "connected"])'),
    "worker detail must treat active, valid, and connected statuses as live",
  );
  assert(
    src.includes("LIVE_CONNECTION_STATUSES.has(String(c.status || \"\").toLowerCase())"),
    "activeConnectionSlugs must filter using LIVE_CONNECTION_STATUSES",
  );
  assert(
    src.includes("Connect and test required tools") &&
      src.includes("Connect ${humanizeOptionLabel(missingConnections[0])} to run") &&
      src.includes("Test connections"),
    "missing connection state must render a clear connect-and-test CTA instead of a plain no-input run",
  );

  const manualMatrix = read("docs/workers/MANUAL-SMOKE-MATRIX.md");
  assert(
    manualMatrix.includes("Connection-gated") &&
      manualMatrix.includes("verify the connect-and-test CTA instead of treating it as a no-input smoke"),
    "manual smoke matrix must classify github-digest as connection-gated",
  );
}

function test691FileSamplesRespectInputContracts(): void {
  const src = readFileSync(WORKER_PAGE, "utf8");
  assert(src.includes('fetch(apiProxyPath("/uploads")'), "sample file upload must use the configured API proxy base");
  assert(
    src.includes('form.append("accepts", JSON.stringify(accepts))') && src.includes('form.append("max_size_mb"'),
    "sample file upload must pass the same accepts/max_size fields as manual upload",
  );

  const types = readFileSync(TYPES, "utf8");
  assert(types.includes("accepts?: string[]") && types.includes("max_size_mb?: number"), "WorkerInput type must expose upload constraints");

  const csvYml = read("workers/csv_enricher/worker.yml");
  assert(!csvYml.includes("csv_file: null"), "csv_enricher example_input must not leave csv_file null");
  assert(csvYml.includes("name,company,title,location"), "csv_enricher must include inline CSV sample content");

  const cvYml = read("workers/cv_writeup/worker.yml");
  assert(cvYml.includes("cv_file: null"), "cv_writeup example_input must leave cv_file null");
}

const tests: [string, () => void][] = [
  ["#668 required inputs gate manual run", test668RequiredInputsGateRun],
  ["#689 no-input workers run without sample-fill", test689NoInputWorkersCanRunWithoutSample],
  ["#690 valid/connected GitHub connections enable run", test690ConnectionGateUsesBackendLiveStatuses],
  ["#691 file-upload worker samples respect input contracts", test691FileSamplesRespectInputContracts],
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
