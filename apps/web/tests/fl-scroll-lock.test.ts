/**
 * Tests for #593 — Emily chat scroll lock fix.
 *
 * Verifies that EmilyChat respects user scroll position while streaming
 * instead of unconditionally forcing the viewport to the bottom.
 *
 * Run: cd apps/web && npx tsx tests/fl-scroll-lock.test.ts
 */

import * as fs from "fs";
import * as path from "path";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", relPath), "utf8");
}

const src = readSrc("components/emily/EmilyChat.tsx");

// ---------------------------------------------------------------------------
// Guard on isNearBottom before auto-scrolling
// ---------------------------------------------------------------------------

function testAutoScrollGuardedByNearBottom() {
  assert(
    src.includes("isNearBottomRef") || src.includes("isNearBottom"),
    "#593: EmilyChat must track whether the user is near the bottom (isNearBottomRef)"
  );
  // The effect that auto-scrolls must be gated on the near-bottom ref
  const effectBlock = src.slice(
    src.indexOf("// Auto-scroll when streaming"),
    src.indexOf("// Always jump to bottom when the USER")
  );
  assert(
    effectBlock.includes("isNearBottomRef.current"),
    "#593: the auto-scroll useEffect must check isNearBottomRef.current before scrolling"
  );
  // Must use direct scrollTop (not scrollIntoView) to avoid animation fighting user scroll
  assert(
    effectBlock.includes("scrollTop") || effectBlock.includes("scrollToBottom"),
    "#593: auto-scroll must use scrollTop (instant) not scrollIntoView (animated) during streaming"
  );
  console.log("✓ #593 auto-scroll is gated on isNearBottomRef");
}

// ---------------------------------------------------------------------------
// Scroll container has onScroll handler
// ---------------------------------------------------------------------------

function testScrollContainerHasHandler() {
  assert(
    src.includes("scrollContainerRef"),
    "#593: a ref must be attached to the scroll container div"
  );
  assert(
    src.includes("onScroll={handleScroll}"),
    "#593: the scroll container must wire up the onScroll handler"
  );
  assert(
    src.includes("handleScroll"),
    "#593: a handleScroll function must exist to update isNearBottomRef"
  );
  console.log("✓ #593 scroll container has onScroll handler");
}

// ---------------------------------------------------------------------------
// Scroll-to-bottom button is rendered when user has scrolled up
// ---------------------------------------------------------------------------

function testScrollToBottomButtonExists() {
  assert(
    src.includes("showScrollButton"),
    "#593: showScrollButton state must exist to control the jump button visibility"
  );
  assert(
    src.includes("Scroll to bottom") || src.includes("scroll-to-bottom") || src.includes("scrollToBottom"),
    "#593: a scroll-to-bottom button or action must be rendered"
  );
  assert(
    src.includes("ChevronDown"),
    "#593: the scroll-to-bottom button should use a ChevronDown icon"
  );
  console.log("✓ #593 scroll-to-bottom button is present");
}

// ---------------------------------------------------------------------------
// Sending a user message always scrolls to bottom
// ---------------------------------------------------------------------------

function testUserMessageAlwaysScrolls() {
  // The scroll effect uses messages[messages.length - 1]?.role === "user"
  const scrollOnUserMsg = 'messages[messages.length - 1]?.role === "user"';
  assert(
    src.includes(scrollOnUserMsg),
    '#593: a separate effect must check messages[messages.length - 1]?.role === "user"'
  );
  const userIdx = src.indexOf(scrollOnUserMsg);
  const blockAround = src.slice(Math.max(0, userIdx - 100), userIdx + 200);
  assert(
    blockAround.includes("scrollIntoView") || blockAround.includes("scrollToBottom"),
    "#593: the user-message check must be followed by a scrollIntoView call"
  );
  console.log("✓ #593 new user message always scrolls to bottom");
}

// ---------------------------------------------------------------------------
// newSession resets scroll state
// ---------------------------------------------------------------------------

function testNewSessionResetsScroll() {
  const newSessionBlock = src.slice(
    src.indexOf("onNew={() => {"),
    src.indexOf("onNew={() => {") + 200
  );
  assert(
    newSessionBlock.includes("isNearBottomRef.current = true") ||
    newSessionBlock.includes("setShowScrollButton(false)"),
    "#593: newSession must reset the scroll state so a fresh chat starts at the bottom"
  );
  console.log("✓ #593 newSession resets scroll state");
}

// ---------------------------------------------------------------------------
// Unconditional scrollIntoView must be gone
// ---------------------------------------------------------------------------

function testNoUnconditionalScrollIntoView() {
  // The old pattern was: useEffect(() => { bottomRef.current?.scrollIntoView(...) }, [messages, isStreaming])
  // Check that the scrollIntoView calls are now guarded
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("scrollIntoView") && !lines[i].trim().startsWith("//")) {
      // Find the surrounding if-block or guard
      const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
      assert(
        context.includes("isNearBottomRef.current") ||
        context.includes('role === "user"') ||
        context.includes("scrollToBottom"),
        `#593: scrollIntoView at line ${i + 1} must be inside a guard (isNearBottomRef or user message check)`
      );
    }
  }
  console.log("✓ #593 no unconditional scrollIntoView calls remain");
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------

const tests: Array<[string, () => void]> = [
  ["auto-scroll gated on isNearBottom", testAutoScrollGuardedByNearBottom],
  ["scroll container has onScroll handler", testScrollContainerHasHandler],
  ["scroll-to-bottom button exists", testScrollToBottomButtonExists],
  ["user message always scrolls", testUserMessageAlwaysScrolls],
  ["newSession resets scroll state", testNewSessionResetsScroll],
  ["no unconditional scrollIntoView", testNoUnconditionalScrollIntoView],
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
