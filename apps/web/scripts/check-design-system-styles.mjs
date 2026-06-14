import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "components"];
const EXTENSIONS = new Set([".css", ".ts", ".tsx"]);
const SKIP_FILES = new Set([path.join("app", "globals.css")]);

const checks = [
  {
    kind: "border",
    allow: "ds-allow-border",
    patterns: [
      /\[border:var\(--bd-(?:card|input|pill|btn|list)\)\]/,
      /\bborder\s+(?:border|border-[^\s"'`}]*)/,
      /\bborder-(?:border|default|input|muted|card|popover|secondary|primary|accent|destructive)\b/,
      /border:\s*["']var\(--bd-(?:card|input|pill|btn|list)\)["']/,
      /border:\s*var\(--bd-(?:card|input|pill|btn|list)\)/,
      /outline:\s*(?!(?:"none"|'none'|none\b|"0"|'0'|0\b))\S/,
      /\boutline-(?!none\b|hidden\b|0\b|color\b)[^\s"'`}]*/,
    ],
  },
  {
    kind: "round",
    allow: "ds-allow-round",
    patterns: [
      /\brounded-full\b/,
      /\brounded-(?:sm|md|lg|xl|2xl|3xl)\b/,
      /var\(--radius-(?:card|button|input|pill|squircle)\)/,
      /var\(--r-pill\)/,
      /borderRadius:\s*["'](?:50%|9999px)/,
      /border-radius:\s*(?:50%|9999px)/,
    ],
  },
];

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry);
    const rel = path.relative(ROOT, abs);
    if (entry === "node_modules" || entry === ".next" || entry === "tests") continue;
    if (SKIP_FILES.has(rel)) continue;
    const info = statSync(abs);
    if (info.isDirectory()) files.push(...walk(abs));
    else if (EXTENSIONS.has(path.extname(entry))) files.push(abs);
  }
  return files;
}

function commentAllowed(lines, index, marker) {
  return [lines[index], lines[index - 1]]
    .filter(Boolean)
    .some((line) => line.includes(marker));
}

const failures = [];

for (const scanDir of SCAN_DIRS) {
  for (const file of walk(path.join(ROOT, scanDir))) {
    const rel = path.relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const check of checks) {
        if (commentAllowed(lines, index, check.allow)) continue;
        if (check.patterns.some((pattern) => pattern.test(line))) {
          failures.push(`${rel}:${index + 1}: ${check.kind} style outside design system`);
        }
      }
    });
  }
}

if (failures.length > 0) {
  console.error("Design-system style guard failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("\nUse background surfaces, spacing, and shadows instead. Add ds-allow-border or ds-allow-round only for a verified functional exception.");
  process.exit(1);
}
