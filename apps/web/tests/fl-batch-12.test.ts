/**
 * Batch-12 tests.
 * #545 — Worker share links: import-from-share flow.
 *
 * Run: npx tsx tests/fl-batch-12.test.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { apiAll } from "./_apisrc";

const ROOT = resolve(__dirname, "..");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function src(rel: string) { return readFileSync(resolve(ROOT, rel), "utf8"); }

// ---------------------------------------------------------------------------
// #545 — Backend: GET /s/{token} includes worker files
// ---------------------------------------------------------------------------

function test545SharePayloadIncludesFiles(): void {
  const s = apiAll();
  assert(
    s.includes("_public_worker_share_from_worker"),
    "main.py must define _public_worker_share_from_worker helper",
  );
  assert(
    s.includes("_read_worker_files") && s.includes("share_files"),
    "_public_worker_share_from_worker must read worker files and include them in payload",
  );
}

// ---------------------------------------------------------------------------
// #545 — Backend: POST /workers/import-from-share endpoint
// ---------------------------------------------------------------------------

function test545ImportEndpointExists(): void {
  const s = apiAll();
  assert(
    s.includes("/workers/import-from-share"),
    "main.py must define POST /workers/import-from-share endpoint",
  );
}

function test545ImportEndpointUsesRegisterFromFiles(): void {
  const s = apiAll();
  assert(
    s.includes("_register_worker_from_files") && s.includes("dedupe_id=True"),
    "import-from-share must call _register_worker_from_files with dedupe_id=True",
  );
}

function test545ImportEndpointValidatesWorkerYml(): void {
  const s = apiAll();
  assert(
    s.includes("worker.yml") && s.includes("missing worker.yml"),
    "import-from-share must reject shares missing worker.yml",
  );
}

function test545ImportEndpointReturnsWorkerId(): void {
  const s = apiAll();
  assert(
    s.includes('"worker_id"') && s.includes('"url"'),
    "import-from-share must return {worker_id, url}",
  );
}

// ---------------------------------------------------------------------------
// #545 — Frontend: api.ts exposes importFromShare
// ---------------------------------------------------------------------------

function test545ApiTsImportFromShare(): void {
  const s = src("lib/api.ts");
  assert(
    s.includes("importFromShare"),
    "lib/api.ts must expose api.workers.importFromShare",
  );
  assert(
    s.includes("/workers/import-from-share"),
    "api.workers.importFromShare must POST to /workers/import-from-share",
  );
}

// ---------------------------------------------------------------------------
// #545 — Frontend: WorkerShareCard has import button
// ---------------------------------------------------------------------------

function test545WorkerShareCardHasTokenProp(): void {
  const s = src("components/share/WorkerShareCard.tsx");
  assert(
    s.includes("token?:") || s.includes("token }: ") || s.includes("token,"),
    "WorkerShareCard must accept a token prop",
  );
}

function test545WorkerShareCardCallsImport(): void {
  const s = src("components/share/WorkerShareCard.tsx");
  assert(
    s.includes("handleImport") && s.includes("api.workers.importFromShare"),
    "WorkerShareCard must call api.workers.importFromShare in handleImport",
  );
}

function test545WorkerShareCardShowsImportingState(): void {
  const s = src("components/share/WorkerShareCard.tsx");
  assert(
    s.includes("importing") && s.includes("Importing"),
    "WorkerShareCard must show loading state while import is in progress",
  );
}

function test545WorkerShareCardRedirectsAfterImport(): void {
  const s = src("components/share/WorkerShareCard.tsx");
  assert(
    s.includes("router.push") && s.includes("/workers?sel="),
    "WorkerShareCard must redirect to the imported worker split-pane detail after import",
  );
}

// ---------------------------------------------------------------------------
// #545 — Frontend: StandaloneShareCard passes token to WorkerShareCard
// ---------------------------------------------------------------------------

function test545StandaloneShareCardPassesToken(): void {
  const s = src("app/s/[token]/StandaloneShareCard.tsx");
  assert(
    s.includes("token={token}"),
    "StandaloneShareCard must pass token prop to WorkerShareCard",
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: [string, () => void][] = [
  ["#545 share payload includes worker files", test545SharePayloadIncludesFiles],
  ["#545 POST /workers/import-from-share endpoint exists", test545ImportEndpointExists],
  ["#545 import-from-share uses _register_worker_from_files with dedupe_id", test545ImportEndpointUsesRegisterFromFiles],
  ["#545 import-from-share validates worker.yml presence", test545ImportEndpointValidatesWorkerYml],
  ["#545 import-from-share returns {worker_id, url}", test545ImportEndpointReturnsWorkerId],
  ["#545 api.ts exposes api.workers.importFromShare", test545ApiTsImportFromShare],
  ["#545 WorkerShareCard accepts token prop", test545WorkerShareCardHasTokenProp],
  ["#545 WorkerShareCard calls api.workers.importFromShare", test545WorkerShareCardCallsImport],
  ["#545 WorkerShareCard shows importing state", test545WorkerShareCardShowsImportingState],
  ["#545 WorkerShareCard redirects to imported worker after success", test545WorkerShareCardRedirectsAfterImport],
  ["#545 StandaloneShareCard passes token to WorkerShareCard", test545StandaloneShareCardPassesToken],
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
