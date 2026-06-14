/**
 * Batch-9 tests.
 * #561 — Trust receipt: tool_calls, approval_trail, can_replay added to RunDetail.
 * #565 — Connection activity: GET /connections/{id}/activity endpoint + frontend.
 *
 * Run: npx tsx tests/fl-batch-9.test.ts
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
// #561 — Backend: models.py new types
// ---------------------------------------------------------------------------

function test561ModelsToolCallEntry(): void {
  const s = api("models.py");
  assert(s.includes("class ToolCallEntry"), "models.py must define ToolCallEntry");
  assert(s.includes("class ApprovalEntry"), "models.py must define ApprovalEntry");
}

function test561ModelsRunDetailNewFields(): void {
  const s = api("models.py");
  const idx = s.indexOf("class RunDetail");
  const section = s.slice(idx, idx + 2000);
  assert(section.includes("tool_calls"), "RunDetail must declare tool_calls field");
  assert(section.includes("approval_trail"), "RunDetail must declare approval_trail field");
  assert(section.includes("can_replay"), "RunDetail must declare can_replay field");
}

// ---------------------------------------------------------------------------
// #561 — Backend: main.py transcript parsing
// ---------------------------------------------------------------------------

function test561MainTranscriptParsing(): void {
  // PR #1073 (oss-prep) moved transcript parsing into services/run_serialize.py
  // and the RunDetail wiring into routers/runs.py.
  const serialize = api("services/run_serialize.py");
  assert(serialize.includes("_parse_tool_calls_from_transcript"), "run_serialize.py must define _parse_tool_calls_from_transcript");
  assert(serialize.includes("ToolCallEntry"), "run_serialize.py must use ToolCallEntry");
  const runs = api("routers/runs.py");
  assert(runs.includes("ApprovalEntry"), "routers/runs.py must import ApprovalEntry");
}

function test561MainAgentTranscriptSupport(): void {
  // PR #1073 moved _read_transcript_rows into services/run_serialize.py.
  const s = api("services/run_serialize.py");
  // _read_transcript_rows must handle agent runners (not just skill)
  assert(s.includes("is_agent"), "_read_transcript_rows must handle agent runner transcripts");
  assert(
    s.includes("outputs/transcript.jsonl"),
    "_read_transcript_rows must look for outputs/transcript.jsonl for agent runners",
  );
}

function test561MainGetRunPopulatesFields(): void {
  // PR #1073 moved the get_run handler into routers/runs.py.
  const s = api("routers/runs.py");
  assert(s.includes("_tool_calls"), "get_run must compute _tool_calls");
  assert(s.includes("_approval_trail"), "get_run must compute _approval_trail");
  assert(s.includes("_can_replay"), "get_run must compute _can_replay");
  assert(s.includes("tool_calls=_tool_calls"), "RunDetail constructor must receive tool_calls");
  assert(s.includes("approval_trail=_approval_trail"), "RunDetail constructor must receive approval_trail");
  assert(s.includes("can_replay=_can_replay"), "RunDetail constructor must receive can_replay");
}

function test561MainApprovalQuery(): void {
  // PR #1073 moved the get_run handler into routers/runs.py.
  const s = api("routers/runs.py");
  assert(
    s.includes("repos.approvals.get_by_run_id(run_id=run_id)"),
    "get_run must call repos.approvals.get_by_run_id",
  );
}

// ---------------------------------------------------------------------------
// #561 — Frontend: types.ts
// ---------------------------------------------------------------------------

function test561TypesNewInterfaces(): void {
  const s = src("lib/types.ts");
  assert(s.includes("interface ToolCallEntry"), "types.ts must define ToolCallEntry interface");
  assert(s.includes("interface ApprovalEntry"), "types.ts must define ApprovalEntry interface");
  const runDetailIdx = s.indexOf("interface RunDetail");
  const section = s.slice(runDetailIdx, runDetailIdx + 2000);
  assert(section.includes("tool_calls"), "RunDetail interface must include tool_calls");
  assert(section.includes("approval_trail"), "RunDetail interface must include approval_trail");
  assert(section.includes("can_replay"), "RunDetail interface must include can_replay");
}

// ---------------------------------------------------------------------------
// #561 — Frontend: RunDetailSplitPane.tsx
// ---------------------------------------------------------------------------

function test561RunDetailToolCallsTab(): void {
  const s = src("components/RunDetailSplitPane.tsx");
  assert(s.includes("tool-calls"), "RunDetailSplitPane must have a tool-calls tab");
  assert(s.includes("ToolCallsView"), "RunDetailSplitPane must render ToolCallsView");
}

function test561RunDetailApprovalTab(): void {
  const s = src("components/RunDetailSplitPane.tsx");
  assert(s.includes("approval_trail"), "RunDetailSplitPane must reference approval_trail");
  assert(s.includes("ApprovalView"), "RunDetailSplitPane must render ApprovalView");
}

function test561RunDetailReplayGated(): void {
  const s = src("components/RunDetailSplitPane.tsx");
  assert(
    s.includes("can_replay"),
    "RunDetailSplitPane must gate the Re-run button on can_replay",
  );
}

function test561CostTotalTokens(): void {
  // Backend: agent_driver writes usage row to transcript
  const agentDriver = readFileSync(
    resolve(API_ROOT, "runner_sandbox/agent_driver.py"),
    "utf8",
  );
  assert(
    agentDriver.includes("\"type\": \"usage\"") || agentDriver.includes('"type": "usage"'),
    "agent_driver must append a usage row to the transcript with total_tokens",
  );
  assert(
    agentDriver.includes("total_tokens"),
    "agent_driver usage row must include total_tokens",
  );

  // Backend: PR #1073 moved usage extraction into services/run_serialize.py
  // and the RunDetail wiring into routers/runs.py.
  const serialize = api("services/run_serialize.py");
  assert(
    serialize.includes("_extract_total_tokens_from_transcript"),
    "run_serialize.py must define _extract_total_tokens_from_transcript",
  );
  const runs = api("routers/runs.py");
  assert(
    runs.includes("total_tokens=_total_tokens"),
    "RunDetail constructor must receive total_tokens",
  );

  // Backend model: RunDetail.total_tokens field
  const models = api("models.py");
  const runDetailIdx = models.indexOf("class RunDetail");
  const section = models.slice(runDetailIdx, runDetailIdx + 2000);
  assert(section.includes("total_tokens"), "RunDetail model must declare total_tokens field");

  // Frontend types
  const types = src("lib/types.ts");
  const rdIdx = types.indexOf("interface RunDetail");
  const rdSection = types.slice(rdIdx, rdIdx + 2000);
  assert(rdSection.includes("total_tokens"), "RunDetail interface must include total_tokens");

  // Frontend component: token count displayed
  const pane = src("components/RunDetailSplitPane.tsx");
  assert(pane.includes("total_tokens"), "RunDetailSplitPane must render total_tokens");
  assert(pane.includes("tokens"), "RunDetailSplitPane must show 'tokens' label for the count");
}

// ---------------------------------------------------------------------------
// #565 — Backend: connection activity endpoint
// ---------------------------------------------------------------------------

function test565BackendActivityEndpoint(): void {
  // PR #1073 moved the connections endpoints into routers/connections.py.
  const s = api("routers/connections.py");
  assert(
    s.includes("/connections/{connection_id}/activity"),
    "connections.py must define GET /connections/{connection_id}/activity endpoint",
  );
  assert(
    s.includes("get_connection_activity"),
    "connections.py must define get_connection_activity handler",
  );
  assert(
    s.includes("list_recent_runs"),
    "get_connection_activity must call list_recent_runs",
  );
}

// ---------------------------------------------------------------------------
// #565 — Frontend: api.ts
// ---------------------------------------------------------------------------

function test565ApiActivityMethod(): void {
  const s = src("lib/api.ts");
  assert(
    s.includes("activity:"),
    "api.ts connections must expose an activity method",
  );
  assert(
    s.includes("/activity"),
    "activity method must call the /activity endpoint",
  );
}

// ---------------------------------------------------------------------------
// #565 — Frontend: connection detail page shows activity
// ---------------------------------------------------------------------------

function test565ConnectionDetailActivitySection(): void {
  const s = src("app/connections/[id]/page.tsx");
  assert(s.includes("activity"), "Connection detail page must fetch and render activity");
  assert(s.includes("RunSummary"), "Connection detail page must use RunSummary type");
  assert(s.includes("RunStatusBadge"), "Connection detail page must show run status in activity log");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: [string, () => void][] = [
  ["#561 models.py defines ToolCallEntry and ApprovalEntry", test561ModelsToolCallEntry],
  ["#561 RunDetail model has tool_calls, approval_trail, can_replay", test561ModelsRunDetailNewFields],
  ["#561 main.py imports and defines transcript parsing helpers", test561MainTranscriptParsing],
  ["#561 _read_transcript_rows handles agent runner transcripts", test561MainAgentTranscriptSupport],
  ["#561 get_run populates all three new fields", test561MainGetRunPopulatesFields],
  ["#561 get_run queries approvals table", test561MainApprovalQuery],
  ["#561 types.ts adds ToolCallEntry, ApprovalEntry, and RunDetail fields", test561TypesNewInterfaces],
  ["#561 RunDetailSplitPane has Tool calls tab with ToolCallsView", test561RunDetailToolCallsTab],
  ["#561 RunDetailSplitPane has Approval tab with ApprovalView", test561RunDetailApprovalTab],
  ["#561 RunDetailSplitPane gates Re-run button on can_replay", test561RunDetailReplayGated],
  ["#561 cost: agent_driver writes usage row; main.py extracts total_tokens; frontend displays it", test561CostTotalTokens],
  ["#565 main.py has GET /connections/{id}/activity endpoint", test565BackendActivityEndpoint],
  ["#565 api.ts connections has activity method", test565ApiActivityMethod],
  ["#565 Connection detail page renders activity log with RunStatusBadge", test565ConnectionDetailActivitySection],
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
