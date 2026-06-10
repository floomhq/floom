/**
 * Batch-3 frontend fix tests.
 * #549 — Approval page Wave 3: one-card + chatbox feedback
 *
 * Run: npx tsx tests/fl-batch-3.test.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const APPROVAL_PAGE = resolve(ROOT, "app/approvals/review/page.tsx");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function testApprovalCard480px(): void {
  const src = readFileSync(APPROVAL_PAGE, "utf8");
  assert(
    src.includes("480px"),
    'Approval card must declare fixed 480px height (style={{ height: "480px" }})'
  );
}

function testChatboxPlaceholder(): void {
  const src = readFileSync(APPROVAL_PAGE, "utf8");
  assert(
    src.includes("Add a comment or drop an image"),
    'Chatbox placeholder must read "Add a comment or drop an image…" (spec-approved wording)'
  );
}

function testDragAndDropPresent(): void {
  const src = readFileSync(APPROVAL_PAGE, "utf8");
  assert(src.includes("onDrop={handleDrop}"), "Chatbox must have onDrop handler");
  assert(src.includes("onDragOver"), "Chatbox must have onDragOver handler");
  assert(src.includes("onDragLeave"), "Chatbox must have onDragLeave handler");
}

function testImageAttachButton(): void {
  const src = readFileSync(APPROVAL_PAGE, "utf8");
  assert(
    src.includes('aria-label="Attach image or file"'),
    "Chatbox must have an image/file attach button with correct aria-label"
  );
  assert(
    src.includes('accept="image/*"'),
    "File input must accept images"
  );
}

function testHeavyAnnotationToolingRemoved(): void {
  const src = readFileSync(APPROVAL_PAGE, "utf8");
  assert(
    !src.includes("TextHighlightAnnotator"),
    "TextHighlightAnnotator must be removed in Wave 3 (replaced by chatbox)"
  );
  assert(
    !src.includes("ScreenshotAnnotator"),
    "ScreenshotAnnotator must be removed in Wave 3 (replaced by chatbox)"
  );
  assert(
    !src.includes("serializeAnnotations"),
    "serializeAnnotations must not be imported (chatbox builds its own payload)"
  );
}

function testNoindexEffect(): void {
  const src = readFileSync(APPROVAL_PAGE, "utf8");
  assert(
    src.includes("noindex,nofollow"),
    "Page must inject noindex meta for signed-link (public) approvals"
  );
}

function testAutoGrowTextarea(): void {
  const src = readFileSync(APPROVAL_PAGE, "utf8");
  assert(
    src.includes("scrollHeight"),
    "Chatbox textarea must auto-grow by reading scrollHeight on change"
  );
  assert(
    src.includes("resize-none"),
    "Textarea must have resize-none (auto-grow handles sizing)"
  );
}

function testApproveRejectBothAlwaysVisible(): void {
  const src = readFileSync(APPROVAL_PAGE, "utf8");
  // showReason toggle pattern must NOT be present — both buttons are always shown.
  assert(
    !src.includes("showReason"),
    "Wave 3 has no two-step reject toggle (showReason removed — both actions always visible)"
  );
}

const tests: [string, () => void][] = [
  ["#549 card is fixed 480px", testApprovalCard480px],
  ["#549 chatbox placeholder wording", testChatboxPlaceholder],
  ["#549 drag-and-drop handlers present", testDragAndDropPresent],
  ["#549 image attach button present", testImageAttachButton],
  ["#549 heavy X4 annotation tooling removed", testHeavyAnnotationToolingRemoved],
  ["#549 noindex meta for shared links", testNoindexEffect],
  ["#549 textarea auto-grows", testAutoGrowTextarea],
  ["#549 approve/reject always visible (no two-step toggle)", testApproveRejectBothAlwaysVisible],
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
