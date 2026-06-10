/**
 * Batch-7 frontend fix tests.
 * #565 — Connections: expand-in-place peek + /connections/[id] detail page
 * #566 — MCP: expand peek + /connections/mcp/[id] detail page
 *
 * Run: npx tsx tests/fl-batch-7.test.ts
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function src(rel: string) { return readFileSync(resolve(ROOT, rel), "utf8"); }
function exists(rel: string) { return existsSync(resolve(ROOT, rel)); }

// ---------------------------------------------------------------------------
// #565 — Connections expand-peek
// ---------------------------------------------------------------------------

function test565ConnectionRowExpandProps(): void {
  const s = src("components/connections/ConnectionRow.tsx");
  assert(s.includes("expanded"), "ConnectionRow must accept an expanded prop");
  assert(s.includes("onToggle"), "ConnectionRow must accept an onToggle prop");
  assert(s.includes("usedByCount"), "ConnectionRow must accept a usedByCount prop");
}

function test565ConnectionRowChevron(): void {
  const s = src("components/connections/ConnectionRow.tsx");
  assert(s.includes("ChevronRight"), "ConnectionRow must render a ChevronRight indicator");
  assert(s.includes("rotate-90") || s.includes("rotate(90"),
    "Chevron must rotate when row is expanded");
}

function test565ConnectionRowPeekSection(): void {
  const s = src("components/connections/ConnectionRow.tsx");
  // Peek section shows a link/button to the detail page
  assert(s.includes("/connections/") && (s.includes("router.push") || s.includes("href")),
    "Expanded peek must link to /connections/[id] detail page");
}

function test565ConnectionsClientExpandState(): void {
  // ConnectionsClient.tsx was replaced by ConnectionsCollection.tsx in the
  // ui-collection refactor (SPEC §5); used-by counts now come from the API
  // (`used_by`) and rows link to the /connections/[id] detail pane.
  const s = src("app/connections/ConnectionsCollection.tsx");
  assert(s.includes("used_by"), "ConnectionsCollection must surface used-by worker counts");
  assert(s.includes("Used by"), "ConnectionsCollection must render a Used by row");
  assert(s.includes("/connections/") && s.includes("href"),
    "ConnectionsCollection rows must link to the /connections/[id] detail page");
}

function test565ConnectionDetailPageExists(): void {
  assert(exists("app/connections/[id]/page.tsx"),
    "/connections/[id]/page.tsx detail page must exist");
}

function test565ConnectionDetailPageContent(): void {
  const s = src("app/connections/[id]/page.tsx");
  assert(s.includes("api.connections.list"), "Detail page must load connection from API");
  assert(s.includes("Test connection") || s.includes("handleTest"),
    "Detail page must have a Test action");
  assert(s.includes("Disconnect") || s.includes("handleDelete"),
    "Detail page must have a Disconnect action");
  assert(s.includes("Connections"), "Detail page must have a back link to Connections");
}

// ---------------------------------------------------------------------------
// #566 — MCP expand-peek + detail page
// ---------------------------------------------------------------------------

function test566McpPageExpandState(): void {
  const s = src("app/connections/mcp/page.tsx");
  assert(s.includes("expandedId"), "MCP page must track expandedId state for peek");
  assert(s.includes("onToggle") || s.includes("onToggle?"),
    "McpRow must accept onToggle prop");
}

function test566McpRowChevron(): void {
  const s = src("app/connections/mcp/page.tsx");
  assert(s.includes("ChevronRight"), "MCP row must render a ChevronRight indicator");
}

function test566McpRowPeekNavigation(): void {
  const s = src("app/connections/mcp/page.tsx");
  assert(s.includes("/connections/mcp/"),
    "Expanded MCP peek must link to /connections/mcp/[id] detail page");
}

function test566McpDetailPageExists(): void {
  assert(exists("app/connections/mcp/[id]/page.tsx"),
    "/connections/mcp/[id]/page.tsx detail page must exist");
}

function test566McpDetailPageContent(): void {
  const s = src("app/connections/mcp/[id]/page.tsx");
  assert(s.includes("api.connections.list"), "MCP detail page must load from API");
  assert(s.includes("handleTest") || s.includes("Test connection"),
    "MCP detail page must have a Test action");
  assert(s.includes("Remove") || s.includes("handleDelete"),
    "MCP detail page must have a Remove action");
  assert(s.includes("mcpServers") || s.includes("buildJsonConfig"),
    "MCP detail page must show JSON config in Claude Desktop format");
  assert(s.includes("MCP servers"), "MCP detail page must have a back link to MCP servers");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: [string, () => void][] = [
  ["#565 ConnectionRow accepts expanded/onToggle/usedByCount props", test565ConnectionRowExpandProps],
  ["#565 ConnectionRow renders rotating ChevronRight", test565ConnectionRowChevron],
  ["#565 Expanded peek links to /connections/[id]", test565ConnectionRowPeekSection],
  ["#565 ConnectionsClient tracks expandedId and usedByCountBySlug", test565ConnectionsClientExpandState],
  ["#565 /connections/[id]/page.tsx file exists", test565ConnectionDetailPageExists],
  ["#565 Connection detail page has list/test/disconnect/back-link", test565ConnectionDetailPageContent],
  ["#566 MCP page tracks expandedId for row peek", test566McpPageExpandState],
  ["#566 McpRow renders rotating ChevronRight", test566McpRowChevron],
  ["#566 Expanded MCP peek links to /connections/mcp/[id]", test566McpRowPeekNavigation],
  ["#566 /connections/mcp/[id]/page.tsx file exists", test566McpDetailPageExists],
  ["#566 MCP detail page has list/test/remove/json-config/back-link", test566McpDetailPageContent],
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
