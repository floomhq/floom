#!/usr/bin/env node
/**
 * lint-borders.mjs  (#1337)
 *
 * Fails (exit 1) when a component file contains prohibited border/ring patterns
 * that would render a visible border on a floating surface at runtime.
 *
 * PROHIBITED:
 *   - Raw Tailwind border utilities as standalone classes:
 *       border  border-t  border-b  border-l  border-r  border-x  border-y  border-[
 *   - Raw ring utilities:
 *       ring-1  ring-2  ring-[
 *   - Literal box-shadow ring segment: "0 0 0 1px" (outset, not inset)
 *   - Inline style: border: "1px solid ..." or border: "N px ..."
 *
 * ALLOWED (explicit allowlist — these are intentional affordances, not borders):
 *   - focus: / focus-visible: prefixed variants (keyboard focus rings)
 *   - inset 0 0 0 1px  (inset affordance e.g. drop-target highlight)
 *   - border-collapse / border-spacing / border-separate  (CSS table layout, not box borders)
 *   - [border:var(--  / [border-  (token-controlled border, resolved to `none` by design system)
 *   - border: 0  /  border: none  /  [border:0]  (explicit reset)
 *   - bg-border  (using border color as fill color for separator lines — allowed)
 *   - fill="var(--border..." (SVG fill, not a box border)
 *   - border-radius / rounded  (radius, not border)
 *   - Lines containing // border-ok or /* border-ok  (per-line opt-out)
 *   - Whole-file opt-out: add "border-ok-file" anywhere in a comment in the file
 *
 * EXPLICIT FILE ALLOWLIST (data tables that legitimately use border-collapse):
 *   - apps/web/components/VersionDiffPanel.tsx  (diff table)
 *   - apps/web/components/generic-output.tsx    (generic output table)
 *   - apps/web/components/worker-form/FilesEditor.tsx  (editor table)
 *   - apps/web/app/approvals/review/page.tsx    (review table)
 *   - apps/web/app/contexts/page.tsx            (contexts data table)
 *
 * Usage:
 *   node scripts/lint-borders.mjs            # report-only (no exit 1) first run
 *   node scripts/lint-borders.mjs --fail     # exit 1 on violations (CI mode)
 *   node scripts/lint-borders.mjs --fix-report  # print grouped violation report
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

// ROOT = apps/web/ (the script is in apps/web/scripts/, go up one level)
const ROOT = new URL("../", import.meta.url).pathname;
const FAIL_MODE = process.argv.includes("--fail");

// Files explicitly allowlisted for border-collapse on data tables
// Paths are relative to ROOT (apps/web/)
const FILE_ALLOWLIST = new Set([
  "components/VersionDiffPanel.tsx",
  "components/generic-output.tsx",
  "components/worker-form/FilesEditor.tsx",
  "app/approvals/review/page.tsx",
  "app/contexts/page.tsx",
]);

// Directories to scan (relative to ROOT = apps/web/)
const SCAN_DIRS = [
  "components",
  "app",
];

// Directories to skip entirely (relative to ROOT)
const SKIP_DIRS = new Set([
  "components/ui",  // primitive token files — border comes from tokens
  "node_modules",
  ".next",
  "dist",
  "out",
]);

/**
 * Returns true if this path should be skipped.
 */
function shouldSkipDir(absPath) {
  const rel = relative(ROOT, absPath);
  return [...SKIP_DIRS].some((skip) => rel === skip || rel.startsWith(skip + "/"));
}

/**
 * Recursively collect .tsx files under dir.
 */
function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!shouldSkipDir(abs)) collectFiles(abs, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Check if a line is a violation.
 * Returns the violation kind string, or null if line is clean.
 */
function checkLine(line, relPath, lineNo) {
  // Per-line opt-out
  if (/border-ok/.test(line)) return null;

  // Skip lines that are entirely inside a JSX block comment continuation.
  // Heuristic: line has no JSX/JS code tokens (no < > = " ' { } ; :) before
  // the border mention, suggesting it's mid-comment prose.
  // A line like "      sticky/backdrop/border-b header pattern" is pure comment prose.

  // Strip JSX/JS comments from analysis (// ... and {/* ... */})
  // We want to flag code, not just comments that reference the word "border"
  const stripped = line
    .replace(/\/\/.*$/, "")           // strip // line comments
    .replace(/\/\*.*?\*\//g, "")      // strip /* */ inline comments
    .replace(/\{\/\*.*?\*\/\}/g, ""); // strip {/* */} JSX comments (single-line only)

  // If the line appears to be a continuation of a multi-line JSX comment
  // (no { } < > = " characters that indicate actual code), skip it.
  // This catches lines like "sticky/backdrop/border-b header pattern (no other..."
  // We use {} < > = " as code-presence signals (parens/semicolons appear in prose too)
  if (!/[{}"'<>=]/.test(stripped) && /border/.test(stripped)) return null;

  const violations = [];

  // --- ALLOWED patterns (check against the raw line, not stripped) ---

  // focus: / focus-visible: prefixed — allowed
  // [border:var(-- — token-controlled, allowed
  // border-collapse / border-spacing / border-separate — table layout, allowed
  // border: 0 / border: none / [border:0] / [border:none] — explicit reset, allowed
  // bg-border — using border color as fill, allowed
  // fill="var(--border — SVG fill, allowed
  // border-radius / rounded — radius, not border

  // --- CHECK: raw Tailwind border utility classes ---
  // Match border-{t,b,l,r,x,y} or border[ as standalone class-like token
  // NOT preceded by [border: (which indicates [border:var(-- token syntax)
  // NOT followed by -collapse / -spacing / -separate / -radius

  // Pattern for standalone Tailwind border utility:
  // \bborder(-[tblrxy])?\b  but NOT:
  //   - focus(-visible)?:border  (focus ring)
  //   - [border:  (arbitrary CSS property)
  //   - border-collapse / border-spacing / border-separate (table layout)
  //   - border-radius (radius)
  //   - "border" as a CSS value string like 'border: none' or 'border: 0'
  //   - bg-border (color token)
  //   - fill="var(--border

  // We check the stripped line for class-name usage
  const borderClassPattern = /(?<![[\w-])border(?:-[tblrxy]|-\[)(?!\s*:(?:var|none|0|\d))(?!-collapse|-spacing|-separate|-radius)/g;
  let m;
  while ((m = borderClassPattern.exec(stripped)) !== null) {
    const before = stripped.slice(Math.max(0, m.index - 15), m.index);
    const after = stripped.slice(m.index + m[0].length, m.index + m[0].length + 20);

    // Skip if inside [border: token pattern
    if (/\[border:/.test(before + stripped.slice(m.index))) continue;
    // Skip focus variants
    if (/focus(-visible)?:$/.test(before.trim().split(/\s+/).pop() ?? "")) continue;
    // Skip if this is bg-border (border as color name)
    if (/\bbg-border\b/.test(line)) continue;
    // Skip fill="var(--border...
    if (/fill="var\(--border/.test(line)) continue;
    // Skip border: 0, border: none (inline style resets)
    if (/border:\s*(0|none|"0"|"none"|\[0\])/.test(line)) continue;

    violations.push(`border utility: ${m[0]}`);
  }

  // --- CHECK: ring-1 / ring-2 / ring-[ (not focus-prefixed) ---
  const ringPattern = /(?<![[\w-])ring-([12]|\[)(?!.*focus)/g;
  while ((m = ringPattern.exec(stripped)) !== null) {
    const before = stripped.slice(Math.max(0, m.index - 20), m.index);
    if (/focus(-visible)?:/.test(before)) continue;
    violations.push(`ring utility: ring-${m[1]}`);
  }

  // --- CHECK: literal 0 0 0 1px in box-shadow (outset ring, not inset) ---
  if (/(?<!inset\s)0\s+0\s+0\s+1px/.test(line)) {
    violations.push("box-shadow ring: 0 0 0 1px (outset)");
  }

  // --- CHECK: inline style border: "1px ..." or border: N+ (not 0/none) ---
  // Catches: border: "1px solid ...", border: "1px ...", style={{ border: "..." }}
  const inlineBorderPattern = /border:\s*["']?(\d+px|\d+\s+\w+)/g;
  while ((m = inlineBorderPattern.exec(line)) !== null) {
    // Skip resets: border: 0, border: "0"
    if (/^(0|"0"|'0')$/.test(m[1].trim())) continue;
    violations.push(`inline border style: border: ${m[1]}`);
  }

  return violations.length > 0 ? violations : null;
}

// --- MAIN ---

const files = SCAN_DIRS.flatMap((d) => collectFiles(join(ROOT, d)));

const allViolations = [];

for (const absPath of files) {
  const rel = relative(ROOT, absPath);

  // Check file-level allowlist
  if (FILE_ALLOWLIST.has(rel)) continue;

  let content;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    continue;
  }

  // Whole-file opt-out
  if (/border-ok-file/.test(content)) continue;

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const violations = checkLine(lines[i], rel, i + 1);
    if (violations) {
      for (const v of violations) {
        allViolations.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 120), kind: v });
      }
    }
  }
}

// Report
if (allViolations.length === 0) {
  console.log("lint:borders — no violations found.");
  process.exit(0);
}

// Group by file for readability
const byFile = {};
for (const v of allViolations) {
  (byFile[v.file] ??= []).push(v);
}

console.log(`\nlint:borders — ${allViolations.length} violation(s) in ${Object.keys(byFile).length} file(s):\n`);

for (const [file, vs] of Object.entries(byFile).sort()) {
  console.log(`  ${file}:`);
  for (const v of vs) {
    console.log(`    line ${v.line}: [${v.kind}]`);
    console.log(`      ${v.text}`);
  }
}

console.log(`
To suppress a specific line:  add // border-ok  at end of line
To suppress a whole file:     add // border-ok-file anywhere in a comment
For data-table border-collapse: add file to FILE_ALLOWLIST in scripts/lint-borders.mjs
`);

if (FAIL_MODE) {
  process.exit(1);
} else {
  console.log("(report-only mode — run with --fail to exit 1 in CI)");
  process.exit(0);
}
