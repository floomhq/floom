/**
 * Batch-5 frontend fix tests.
 * #536 — Worker Source: code files (run.py etc.) should show Preview/Raw tabs
 * #551 — canRun gate must block when worker.status === "missing_secret"
 *
 * Run: npx tsx tests/fl-batch-5.test.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const FILES_EDITOR = resolve(ROOT, "components/worker-form/FilesEditor.tsx");
const WORKER_PAGE = resolve(ROOT, "app/workers/[id]/page.tsx");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

// ---------------------------------------------------------------------------
// #536 — Preview/Raw tabs for code files
// ---------------------------------------------------------------------------

function test536CodeInSupportsRenderedPreview(): void {
  const src = readFileSync(FILES_EDITOR, "utf8");
  assert(
    src.includes('"code"') && src.includes("supportsRenderedPreview"),
    'supportsRenderedPreview must include "code" kind so run.py / .sh / .json files get Preview+Raw tabs'
  );
  // The old comment said code files were deliberately excluded — check that's gone.
  assert(
    !src.includes('"rendered" form is just the same syntax-highlighted source'),
    "Old exclusion comment should be removed (code files now have a distinct plain-text Preview)"
  );
}

function test536CodePreviewIsPlainText(): void {
  const src = readFileSync(FILES_EDITOR, "utf8");
  // RenderedFilePreview must have a "code" branch that renders a <pre> block (plain text).
  assert(
    src.includes('sourceFileKind(path, detected) === "code"'),
    'RenderedFilePreview must have a branch for kind === "code"'
  );
  assert(
    src.includes("whitespace-pre-wrap"),
    "Code Preview must use whitespace-pre-wrap for readable plain-text display"
  );
}

function test536YamlStillSingleView(): void {
  const src = readFileSync(FILES_EDITOR, "utf8");
  // "yaml" must NOT appear in the supportsRenderedPreview returns list —
  // generic .yaml/.yml files should still have a single syntax-highlighted view.
  const fnBlock = src.slice(
    src.indexOf("function supportsRenderedPreview"),
    src.indexOf("function hasWorkerYamlSummary")
  );
  assert(
    !fnBlock.includes('"yaml"'),
    'supportsRenderedPreview must NOT include "yaml" — generic YAML files keep single view'
  );
}

function test536PreviewDefaultsForCodeFiles(): void {
  const src = readFileSync(FILES_EDITOR, "utf8");
  // defaultSourceMode must still start on "preview" for code files.
  // Since supportsRenderedPreview now returns true for code, defaultSourceMode
  // will call it and get "preview" back — so the code file opens on Plain Text tab.
  assert(
    src.includes("if (supportsRenderedPreview(path)) return") ||
    src.includes('supportsRenderedPreview(path, binary)) return "preview"') ||
    src.includes("supportsRenderedPreview(path)) return"),
    "defaultSourceMode must call supportsRenderedPreview to select default tab"
  );
}

// ---------------------------------------------------------------------------
// #551 — canRun gate: missing secrets
// ---------------------------------------------------------------------------

function test551CanRunBlocksOnMissingSecret(): void {
  const src = readFileSync(WORKER_PAGE, "utf8");
  // canRun must be gated on missing_secret status — either directly or via a
  // local boolean declared just before canRun.
  const canRunLine = src.split("\n").find(
    (line) => line.includes("const canRun =") && line.includes("missingConnections")
  );
  assert(Boolean(canRunLine), "canRun declaration must reference missingConnections");
  // The line itself must reference missing secret — either literally or through
  // a local var declared immediately above it.
  const canRunIndex = src.split("\n").findIndex(
    (line) => line.includes("const canRun =") && line.includes("missingConnections")
  );
  const surroundingLines = src.split("\n").slice(Math.max(0, canRunIndex - 3), canRunIndex + 1).join("\n");
  assert(
    surroundingLines.includes("missing_secret"),
    "The missing_secret check must appear in or immediately before the canRun declaration"
  );
}

function test551RunButtonLabelForMissingSecret(): void {
  const src = readFileSync(WORKER_PAGE, "utf8");
  assert(
    src.includes("missing secret"),
    'Run button label must include "missing secret" text when secrets are absent'
  );
}

function test551SecretWarningBlockInRunSection(): void {
  const src = readFileSync(WORKER_PAGE, "utf8");
  // RunSection must show an amber warning block when worker.status === "missing_secret".
  assert(
    src.includes('worker.status === "missing_secret"') &&
    src.includes("KeyRound"),
    "RunSection must render a missing-secret warning block with KeyRound icon"
  );
  assert(
    src.includes("/secrets"),
    'Missing-secret warning must link to /secrets so users can resolve it'
  );
}

function test551SecretWarningNotShownForHealthyWorker(): void {
  const src = readFileSync(WORKER_PAGE, "utf8");
  // The RunSection warning must be inside a JSX conditional (wrapped in &&).
  // Check that there's a {worker.status === "missing_secret" && ( pattern
  // OR that KeyRound appears inside a conditional block.
  assert(
    src.includes('{worker.status === "missing_secret"') ||
    src.includes("worker.status === \"missing_secret\" && ("),
    'Missing-secret warning must be conditionally rendered with {worker.status === "missing_secret" && ...}'
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: [string, () => void][] = [
  ["#536 supportsRenderedPreview includes 'code' kind", test536CodeInSupportsRenderedPreview],
  ["#536 RenderedFilePreview has plain-text code branch", test536CodePreviewIsPlainText],
  ["#536 generic .yaml files keep single-view (no Preview/Raw tabs)", test536YamlStillSingleView],
  ["#536 defaultSourceMode picks 'preview' for code files", test536PreviewDefaultsForCodeFiles],
  ["#551 canRun gates on missing_secret status", test551CanRunBlocksOnMissingSecret],
  ["#551 Run button label mentions missing secret", test551RunButtonLabelForMissingSecret],
  ["#551 RunSection shows amber warning block with /secrets link", test551SecretWarningBlockInRunSection],
  ["#551 missing_secret warning is conditional (not always shown)", test551SecretWarningNotShownForHealthyWorker],
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
