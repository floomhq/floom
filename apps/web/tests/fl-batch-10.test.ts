/**
 * Batch-10 tests.
 * #551 — Connections gate + scheduler gate for missing secrets/connections.
 * #556 Surface 3 — setup_incomplete attention items in global overview bell.
 *
 * Run: npx tsx tests/fl-batch-10.test.ts
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
// #551 — Backend: connections gate in POST /workers/{id}/runs
// ---------------------------------------------------------------------------

function test551ConnectionsGateInCreateRun(): void {
  const s = api("main.py");
  assert(
    s.includes("_run_available_conn_slugs") && s.includes("_run_missing_conns"),
    "POST /workers/{id}/runs must check for missing connections",
  );
  assert(
    s.includes("Cannot run: missing required connection"),
    "POST /workers/{id}/runs must return descriptive error for missing connections",
  );
}

// ---------------------------------------------------------------------------
// #551 — Backend: scheduler gate for missing secrets + connections
// ---------------------------------------------------------------------------

function test551SchedulerMissingSecretsHelper(): void {
  const s = api("scheduler.py");
  assert(
    s.includes("_missing_secrets_for_scheduled_worker"),
    "scheduler.py must define _missing_secrets_for_scheduled_worker helper",
  );
  assert(
    s.includes("_missing_connections_for_scheduled_worker"),
    "scheduler.py must define _missing_connections_for_scheduled_worker helper",
  );
}

function test551SchedulerChecksSecretsTriggerRows(): void {
  const s = api("scheduler.py");
  assert(
    s.includes("_sched_missing_secrets") && s.includes("_sched_missing_conns"),
    "Scheduler trigger-rows path must check _sched_missing_secrets and _sched_missing_conns",
  );
  // Should appear at least twice (once for trigger rows, once for legacy scalar)
  const secretsOccurrences = (s.match(/_sched_missing_secrets/g) || []).length;
  assert(secretsOccurrences >= 2, "Scheduler must check secrets in both trigger-rows AND legacy-scalar paths");
}

function test551SchedulerSkipsRunOnMissingSecrets(): void {
  const s = api("scheduler.py");
  assert(
    s.includes("Skipping schedule trigger") && s.includes("missing secret"),
    "Scheduler trigger-rows path must log and skip when secrets missing",
  );
  assert(
    s.includes("Skipping scheduled run") && s.includes("missing secret"),
    "Scheduler legacy-scalar path must log and skip when secrets missing",
  );
}

function test551SchedulerSkipsRunOnMissingConnections(): void {
  const s = api("scheduler.py");
  assert(
    s.includes("missing connection"),
    "Scheduler must log and skip when connections missing",
  );
}

// ---------------------------------------------------------------------------
// #556 Surface 3 — Backend: setup_incomplete in overview attention items
// ---------------------------------------------------------------------------

function test556OverviewSetupIncompleteItems(): void {
  // #1073 refactor extracted system_overview out of main.py into
  // routers/overview.py; grep the symbols where they now live.
  const s = api("routers/overview.py");
  assert(
    s.includes("setup_incomplete"),
    "system_overview must add setup_incomplete attention items",
  );
  assert(
    s.includes("missing_secret") && s.includes("missing_connection"),
    "setup_incomplete items must distinguish missing_secret vs missing_connection kind",
  );
}

function test556OverviewComputesMissingForAllWorkers(): void {
  // #1073 refactor: overview helpers moved main.py -> routers/overview.py.
  const s = api("routers/overview.py");
  assert(
    s.includes("_ov_available_secrets") && s.includes("_ov_available_conns"),
    "system_overview must compute available secrets and connections for attention items",
  );
  assert(
    s.includes("_ov_missing_secrets") && s.includes("_ov_missing_conns"),
    "system_overview must compute missing secrets and connections per worker",
  );
}

// ---------------------------------------------------------------------------
// #556 Surface 3 — Frontend: AlertsBell shows setup_incomplete items
// ---------------------------------------------------------------------------

function test556AlertsBellSetupItems(): void {
  const s = src("components/overview/AlertsBell.tsx");
  assert(s.includes("setupItems"), "AlertsBell must define setupItems");
  assert(
    s.includes("type === \"setup_incomplete\""),
    "AlertsBell must filter items with type=setup_incomplete",
  );
  assert(
    s.includes("need setup"),
    "AlertsBell must render 'need setup' text for setup_incomplete items",
  );
  assert(
    s.includes("KeyRound"),
    "AlertsBell must use KeyRound icon for setup items",
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: [string, () => void][] = [
  ["#551 POST /workers/{id}/runs gates on missing connections", test551ConnectionsGateInCreateRun],
  ["#551 scheduler.py defines missing secrets/connections helpers", test551SchedulerMissingSecretsHelper],
  ["#551 scheduler checks secrets+connections in both paths", test551SchedulerChecksSecretsTriggerRows],
  ["#551 scheduler skips run when secrets missing (both paths)", test551SchedulerSkipsRunOnMissingSecrets],
  ["#551 scheduler skips run when connections missing", test551SchedulerSkipsRunOnMissingConnections],
  ["#556 Surface 3: system_overview adds setup_incomplete attention items", test556OverviewSetupIncompleteItems],
  ["#556 Surface 3: overview computes missing secrets/connections per worker", test556OverviewComputesMissingForAllWorkers],
  ["#556 Surface 3: AlertsBell renders setup_incomplete with KeyRound icon", test556AlertsBellSetupItems],
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
