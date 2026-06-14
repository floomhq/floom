/**
 * Batch-11 tests.
 * #508 — FL12: Connections trust peek for last emails.
 *
 * Run: npx tsx tests/fl-batch-11.test.ts
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
// #508 — Backend: _fetch_email_peek helper
// ---------------------------------------------------------------------------

function test508BackendFetchEmailPeekHelper(): void {
  const s = api("routers/connections.py");
  assert(s.includes("_fetch_email_peek"), "routers/connections.py must define _fetch_email_peek helper");
  assert(
    s.includes("GMAIL_FETCH_EMAILS"),
    "_fetch_email_peek must call GMAIL_FETCH_EMAILS",
  );
  assert(
    s.includes("max_results"),
    "_fetch_email_peek must pass max_results argument",
  );
  assert(
    s.includes("include_spam_trash"),
    "_fetch_email_peek must exclude spam/trash from preview",
  );
}

function test508BackendPeekEndpoint(): void {
  const s = api("routers/connections.py");
  assert(
    s.includes("/connections/{connection_id}/peek"),
    "routers/connections.py must define GET /connections/{connection_id}/peek endpoint",
  );
  assert(
    s.includes("get_connection_peek"),
    "routers/connections.py must define get_connection_peek handler",
  );
  assert(
    s.includes("_ConnectionPeekResponse"),
    "peek endpoint must return _ConnectionPeekResponse model",
  );
}

function test508BackendPeekOnlyForActiveGmail(): void {
  const s = api("routers/connections.py");
  assert(
    s.includes("toolkit_slug != \"gmail\"") || s.includes("toolkit_slug == \"gmail\""),
    "_fetch_email_peek must be gmail-specific",
  );
  assert(
    s.includes("status") && s.includes("active"),
    "peek endpoint must only return data for active connections",
  );
}

function test508BackendDefensiveResponseParsing(): void {
  const s = api("routers/connections.py");
  assert(
    s.includes("response_data") && s.includes("response_dict"),
    "_fetch_email_peek must handle multiple Composio response shapes",
  );
  assert(
    s.includes("messages") || s.includes("emails"),
    "_fetch_email_peek must look for messages or emails key in response",
  );
  assert(
    s.includes(":120") || s.includes(":80"),
    "_fetch_email_peek must truncate subject/from fields",
  );
}

// ---------------------------------------------------------------------------
// #508 — Frontend: api.ts peek method
// ---------------------------------------------------------------------------

function test508ApiPeekMethod(): void {
  const s = src("lib/api.ts");
  assert(s.includes("peek:"), "api.ts connections must expose a peek method");
  assert(
    s.includes("/peek"),
    "peek method must call the /peek endpoint",
  );
  assert(
    s.includes("from_name") && s.includes("from_email"),
    "peek method return type must include from_name and from_email",
  );
}

// ---------------------------------------------------------------------------
// #508 — Frontend: connection detail page shows email trust peek
// ---------------------------------------------------------------------------

function test508ConnectionDetailEmailPeek(): void {
  const s = src("app/connections/[id]/page.tsx");
  assert(s.includes("emailPeek"), "Connection detail page must maintain emailPeek state");
  assert(
    s.includes("api.connections.peek"),
    "Connection detail page must call api.connections.peek",
  );
  assert(
    s.includes("Recent emails"),
    "Connection detail page must render 'Recent emails' heading",
  );
  assert(
    s.includes("trust signal"),
    "Connection detail page must label the peek as a trust signal",
  );
  assert(
    s.includes("Mail"),
    "Connection detail page must use Mail icon for email peek section",
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: [string, () => void][] = [
  ["#508 main.py defines _fetch_email_peek with GMAIL_FETCH_EMAILS", test508BackendFetchEmailPeekHelper],
  ["#508 main.py has GET /connections/{id}/peek endpoint", test508BackendPeekEndpoint],
  ["#508 peek only activates for active gmail connections", test508BackendPeekOnlyForActiveGmail],
  ["#508 _fetch_email_peek handles multiple Composio response shapes defensively", test508BackendDefensiveResponseParsing],
  ["#508 api.ts connections has peek method with from_name/from_email fields", test508ApiPeekMethod],
  ["#508 connection detail page fetches and renders email trust peek", test508ConnectionDetailEmailPeek],
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
