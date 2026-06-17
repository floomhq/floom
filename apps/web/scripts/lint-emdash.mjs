import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["app", "components", "lib"];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, files);
    } else if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

function isAllowed(line) {
  const trimmed = line.trim();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    line.includes("{/*") ||
    line.includes("*/}") ||
    line.includes("//") ||
    line.includes("/*") ||
    trimmed.includes("em-dash-ok") ||
    trimmed.includes("Binary")
  ) {
    return true;
  }

  return (
    /<span[^>]*>—<\/span>/.test(line) ||
    /return\s+"—"/.test(line) ||
    /label:\s+"—"/.test(line) ||
    /\?\?\s+"—"/.test(line) ||
    /\|\|\s+"—"/.test(line)
  );
}

const hits = [];
for (const root of roots) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes("—") && !isAllowed(line)) {
        hits.push(`${file}:${index + 1}:${line}`);
      }
    });
  }
}

if (hits.length) {
  console.error(
    "Em dash (U+2014) found in copy strings. Replace with comma/colon/semicolon/parens, or add em-dash-ok to opt out."
  );
  console.error(hits.join("\n"));
  process.exit(1);
}
