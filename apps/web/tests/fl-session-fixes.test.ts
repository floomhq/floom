/**
 * Tests for fixes from the 2026-06-08 testing session.
 *
 *   #586 — Proxy route wraps fetch in try/catch → 502 instead of 500 crash
 *   #591 — useChatStream subscribes to run SSE stream for "running" tool cards
 *           so the "Starting worker run" spinner resolves when the run finishes
 *   #590 — _run_visible_to_api ownership-based visibility + PUBLIC_STOCK list
 *   #587 — useRunStream recovers from a dead SSE stream and exposes refresh UI
 *
 * Run: cd apps/web && npx tsx tests/fl-session-fixes.test.ts
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", relPath), "utf8");
}

// ---------------------------------------------------------------------------
// #586 — Proxy route must return 502 on ECONNREFUSED, not crash with 500
// ---------------------------------------------------------------------------

function testProxyHasTryCatch() {
  const src = readSrc("app/api/proxy/[...path]/route.ts");

  assert(
    src.includes("try {") && src.includes("catch"),
    "#586: proxy route.ts must wrap the upstream fetch() in a try/catch block"
  );
  assert(
    src.includes("502"),
    "#586: proxy route.ts must return HTTP 502 when the backend is unreachable"
  );
  assert(
    src.includes("Could not reach the API server"),
    "#586: proxy route.ts must include a human-readable message in the 502 body"
  );
  // The upstream fetch must be inside the try block
  const tryIndex = src.indexOf("try {");
  const fetchIndex = src.indexOf("upstream = await fetch(upstreamUrl");
  assert(
    fetchIndex > tryIndex,
    "#586: the upstream fetch() call must appear after the try { opening"
  );
  console.log("✓ #586 proxy 502 catch is in place");
}

// ---------------------------------------------------------------------------
// #591 — useChatStream must subscribe to run streams for running tool cards
// ---------------------------------------------------------------------------

function testChatStreamSubscribesToRunStream() {
  const src = readSrc("lib/useChatStream.ts");

  assert(
    src.includes("subscribedCardIds"),
    "#591: useChatStream must track subscribed card IDs to avoid duplicate EventSource connections"
  );
  assert(
    src.includes("card.streams?.parts") || src.includes("streams?.parts"),
    "#591: useChatStream must check card.streams.parts to find the run SSE stream URL"
  );
  assert(
    src.includes("new EventSource("),
    "#591: useChatStream must open an EventSource to the run stream"
  );
  assert(
    src.includes("applyFinalStatus") || (src.includes('"completed"') && src.includes('"failed"') && src.includes("setMessages")),
    "#591: useChatStream must call setMessages to update card status on run completion"
  );
  assert(
    src.includes('data.type === "finish"'),
    "#591: useChatStream must watch for the finish part type to determine run completion"
  );
  // Cleanup: sources must be closed on unmount
  assert(
    src.includes("source.close()"),
    "#591: useChatStream must close EventSource connections when cleaning up"
  );
  console.log("✓ #591 useChatStream subscribes to run streams for running tool cards");
}

function testChatStreamFallbackPoll() {
  const src = readSrc("lib/useChatStream.ts");

  assert(
    src.includes("source.onerror"),
    "#591: useChatStream must handle EventSource onerror for resilience"
  );
  assert(
    src.includes("fetch(apiProxyPath") || src.includes("apiProxyPath(`/runs/"),
    "#591: useChatStream must fall back to a REST poll of /runs/{id} when the SSE stream errors"
  );
  console.log("✓ #591 fallback REST poll on SSE error is present");
}

function testChatStreamNewSessionClearsSubscriptions() {
  const src = readSrc("lib/useChatStream.ts");

  // Find newSession callback
  const newSessionIdx = src.indexOf("const newSession = useCallback");
  assert(newSessionIdx !== -1, "newSession callback must exist in useChatStream");

  // The callback body (up to the closing bracket) must clear subscribedCardIds
  const callbackBody = src.slice(newSessionIdx, newSessionIdx + 400);
  assert(
    callbackBody.includes("subscribedCardIds.current.clear()"),
    "#591: newSession must clear subscribedCardIds so stale subscriptions don't leak across sessions"
  );
  console.log("✓ #591 newSession clears subscribedCardIds ref");
}

// ---------------------------------------------------------------------------
// Verify getToolCardTitle produces correct labels for terminal statuses
// ---------------------------------------------------------------------------

function testToolCardTitleForWorkersRun() {
  // This tests the existing label map is correct for workers.run terminal states.
  // Import dynamically since this is a .ts module.
  const src = readSrc("lib/useChatStream.ts");

  const hasWorkersRun = src.includes('"workers.run"');
  assert(hasWorkersRun, "TOOL_LABELS must have an entry for 'workers.run'");

  const completedLabel = src.includes('"Started worker run"');
  const runningLabel = src.includes('"Starting worker run"');
  assert(completedLabel, "workers.run completed label must be 'Started worker run'");
  assert(runningLabel, "workers.run running label must be 'Starting worker run'");
  console.log("✓ workers.run labels are correct in TOOL_LABELS");
}

// ---------------------------------------------------------------------------
// #587 — useRunStream must recover from a dead stream and expose refresh UI
// ---------------------------------------------------------------------------

function testRunStreamRecoveryState() {
  const src = readSrc("lib/useRunStream.ts");
  assert(src.includes("streamUnavailable"), "#587: useRunStream must track streamUnavailable state");
  assert(src.includes("setStreamUnavailable(true)"), "#587: useRunStream must mark the stream unavailable when polling fails");
  assert(src.includes("setRefreshNonce"), "#587: useRunStream must expose a refresh-triggering nonce");
  assert(src.includes("Lost connection to run status"), "#587: useRunStream must surface a stale-connection message");
  console.log("✓ #587 useRunStream tracks streamUnavailable + refresh nonce");
}

function testRunDetailShowsRefreshBanner() {
  const src = readSrc("components/RunDetailSplitPane.tsx");
  assert(src.includes("streamUnavailable"), "#587: RunDetailSplitPane must accept streamUnavailable");
  assert(src.includes("Refresh status"), "#587: RunDetailSplitPane must show a Refresh status action");
  assert(src.includes("Run status connection lost"), "#587: RunDetailSplitPane must show the lost-connection banner");
  assert(src.includes("onRefresh"), "#587: RunDetailSplitPane must accept a refresh callback");
  console.log("✓ #587 RunDetailSplitPane renders the recovery banner");
}

function testRunPagesWireRefreshCallback() {
  const runPage = readSrc("app/runs/[id]/page.tsx");
  const workerPage = readSrc("app/workers/[id]/page.tsx");
  assert(runPage.includes("streamUnavailable"), "#587: run detail page must read streamUnavailable from the hook");
  assert(runPage.includes("onRefresh={refresh}"), "#587: run detail page must wire the refresh callback");
  assert(workerPage.includes("redirect") && workerPage.includes("/workers?sel="), "#587: legacy worker detail route must redirect to split-pane detail");
  console.log("✓ #587 run page wires the recovery callback; worker detail route redirects to split-pane detail");
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

const tests: Array<[string, () => void]> = [
  ["proxy 502 catch (#586)", testProxyHasTryCatch],
  ["chat stream subscribes to run stream (#591)", testChatStreamSubscribesToRunStream],
  ["chat stream fallback REST poll (#591)", testChatStreamFallbackPoll],
  ["newSession clears subscriptions (#591)", testChatStreamNewSessionClearsSubscriptions],
  ["workers.run TOOL_LABELS correct (#591)", testToolCardTitleForWorkersRun],
  ["useRunStream tracks stale stream recovery (#587)", testRunStreamRecoveryState],
  ["RunDetailSplitPane shows refresh banner (#587)", testRunDetailShowsRefreshBanner],
  ["run pages wire refresh callback (#587)", testRunPagesWireRefreshCallback],
];

let passed = 0;
let failed = 0;

for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}: ${(err as Error).message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
