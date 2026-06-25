/**
 * lint-detail-tabs.mjs
 *
 * Scan Collection detail tab objects. Rules:
 *   FAIL  — a tab with `render:` and no sibling `custom:` (bare freeform tab).
 *   WARN  — count tabs with `custom: "unmigrated"` (tracked debt, not a failure).
 *   PASS  — every render: has a custom:, exit 0.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPLICIT_FILES = [
  "app/connections/browse/page.tsx",
  "app/settings/page.tsx",
];

const GLOB_PATTERNS = [
  "app/approvals/ApprovalsCollection.tsx",
  "app/brain/BrainCollection.tsx",
  "app/connections/ConnectionsCollection.tsx",
  "app/runs/RunsCollection.tsx",
  "app/workers/WorkersCollection.tsx",
];

// Walk app/**/*Collection.tsx
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const allAppFiles = walk("app");
const collectionFiles = allAppFiles.filter((f) => f.endsWith("Collection.tsx"));

const filesToScan = [
  ...new Set([
    ...collectionFiles,
    ...EXPLICIT_FILES,
    ...GLOB_PATTERNS,
  ]),
];

let failures = 0;
let unmigrated = 0;

for (const file of filesToScan) {
  let src;
  try {
    src = readFileSync(resolve(file), "utf8");
  } catch {
    continue;
  }

  // Split into lines for line-by-line scan.
  const lines = src.split(/\r?\n/);

  // Strategy: find each `render:` that appears inside a tab object literal.
  // We detect a "tab object" as a block that is part of a `tabs:` array.
  // Simple heuristic: for each `render:` line, look backwards (up to 30 lines)
  // for a matching `custom:` key in the same brace depth, and look backwards
  // for an enclosing `tabs:` context.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments and type definition lines (render: () => React.ReactNode)
    const trimmed = line.trim();
    if (!trimmed.includes("render:")) continue;
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.includes("React.ReactNode") ||
      trimmed.includes("ReactNode") ||
      // type / interface definitions
      /^\s*render\s*\?\s*:/.test(line) ||
      /render\s*:\s*\(.*\)\s*=>\s*React/.test(line) ||
      /render\s*:\s*\(.*\)\s*=>\s*ReactNode/.test(line)
    ) {
      continue;
    }
    // Skip add.panel.render (not a tab)
    // Look back for `panel:` within the same object block (up to 10 lines)
    let isPanelRender = false;
    for (let back = Math.max(0, i - 10); back < i; back++) {
      if (lines[back].trim().startsWith("panel:")) {
        isPanelRender = true;
        break;
      }
    }
    if (isPanelRender) continue;

    // Check whether this render: is inside a tabs array by looking back
    // for `tabs:` within the surrounding context (up to 60 lines).
    let inTabsContext = false;
    let braceDepth = 0;
    for (let back = i - 1; back >= Math.max(0, i - 60); back--) {
      const bl = lines[back];
      // Track brace depth going backwards
      for (const ch of [...bl].reverse()) {
        if (ch === "}") braceDepth++;
        else if (ch === "{") braceDepth--;
      }
      // If we're back at zero brace depth and see `tabs:`, we're in a tabs array
      if (braceDepth <= 0 && /\btabs\s*:/.test(bl)) {
        inTabsContext = true;
        break;
      }
      // If depth goes very negative, we've exited the containing object
      if (braceDepth < -3) break;
    }
    if (!inTabsContext) continue;

    // Now check if there's a `custom:` in the same tab object literal
    // Look at a window of ±20 lines for `custom:` at the same approximate indent
    let hasCustom = false;

    // Check the render: line itself (inline object like { key, custom: "x", render: () => ... })
    if (/\bcustom\s*:/.test(line)) {
      hasCustom = true;
    }

    // Look backwards from i (staying within the same object literal)
    let depth = 0;
    for (let back = i - 1; back >= Math.max(0, i - 20); back--) {
      const bl = lines[back];
      for (const ch of [...bl].reverse()) {
        if (ch === "}") depth++;
        else if (ch === "{") depth--;
      }
      if (depth < 0) break; // left the object
      if (/\bcustom\s*:/.test(bl)) {
        hasCustom = true;
        break;
      }
    }
    // Also look forward
    if (!hasCustom) {
      depth = 0;
      for (let fwd = i + 1; fwd < Math.min(lines.length, i + 20); fwd++) {
        const fl = lines[fwd];
        for (const ch of fl) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }
        if (depth < 0) break; // left the object
        if (/\bcustom\s*:/.test(fl)) {
          hasCustom = true;
          break;
        }
      }
    }

    if (!hasCustom) {
      console.error(`FAIL ${file}:${i + 1}: tab with render: and no custom:`);
      failures++;
    }
  }

  // Count `custom: "unmigrated"` occurrences
  const matches = src.match(/custom\s*:\s*["']unmigrated["']/g);
  if (matches) unmigrated += matches.length;
}

if (unmigrated > 0) {
  console.warn(
    `lint:detail-tabs — ${unmigrated} tabs still custom:"unmigrated" (tracked debt, convert to structured)`
  );
}

if (failures > 0) {
  process.exit(1);
}

console.log("lint:detail-tabs — OK");
