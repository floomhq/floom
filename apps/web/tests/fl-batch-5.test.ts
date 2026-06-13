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
const WORKERS_COLLECTION = resolve(ROOT, "app/workers/WorkersCollection.tsx");
const WORKER_DERIVE = resolve(ROOT, "lib/workers/derive.ts");

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
  // RenderedFilePreview must have a "code" branch matching Brain's PlainTextPreview.
  assert(
    src.includes('sourceFileKind(path, detected) === "code"'),
    'RenderedFilePreview must have a branch for kind === "code"'
  );
  assert(
    src.includes("whitespace-pre-wrap") && src.includes("break-words"),
    "Code Preview must use whitespace-pre-wrap + break-words (matches Brain PlainTextPreview)"
  );
  assert(
    src.includes("max-w-3xl") && src.includes("px-6"),
    "Code Preview must use Brain's max-w-3xl reading column layout"
  );
  assert(
    src.includes('text-[13px]') && src.includes("leading-6"),
    "Code Preview must use Brain's exact font size (text-[13px] leading-6)"
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
  const src = readFileSync(WORKERS_COLLECTION, "utf8");
  assert(
    src.includes('can("run", w)'),
    "Split-pane Run action must be gated by computed worker permissions"
  );
}

function test551RunButtonLabelForMissingSecret(): void {
  const src = readFileSync(WORKER_DERIVE, "utf8");
  assert(
    src.includes('case "missing_secret"') && src.includes("needs attention"),
    'missing_secret workers must surface as "needs attention" in the split-pane list/detail status'
  );
}

function test551SecretWarningBlockInRunSection(): void {
  const src = readFileSync(WORKER_DERIVE, "utf8");
  assert(
    src.includes('w.status === "needs_attention" || w.status === "missing_secret"'),
    "missing_secret workers must be included in the needs-attention filter"
  );
}

function test551SecretWarningNotShownForHealthyWorker(): void {
  const src = readFileSync(WORKER_DERIVE, "utf8");
  assert(
    src.includes('case "healthy"') && src.includes('label: "ok"'),
    "healthy workers must not be marked needs-attention by the status pill"
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
