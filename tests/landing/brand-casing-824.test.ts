// #824 — user-facing landing copy is Floom. Code identifiers (e.g.
// @floomhq/floom, workeros-mcp, cookie names, domains) are lowercase and
// unaffected.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(tsx?|css|mdx?)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("brand casing (#824)", () => {
  it("has no legacy mixed-case brand anywhere in landing sources", () => {
    const root = path.resolve(__dirname, "../..");
    const offenders: string[] = [];
    for (const dir of ["app", "components", "lib"]) {
      for (const file of walk(path.join(root, dir))) {
        const lines = readFileSync(file, "utf-8").split("\n");
        lines.forEach((line, i) => {
          if (/\b(?:WorkerOS|Workeros)\b/.test(line)) {
            offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
