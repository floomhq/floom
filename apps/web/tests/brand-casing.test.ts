import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// User-facing brand is now "Floom", never "WorkerOS" or "Workeros".
// Package/identifiers may retain lowercase legacy compatibility names
// (workeros_*, WORKEROS_*, x-workeros, legacy CLI aliases).
// This scan guards against capitalized legacy brand display strings slipping in.

const ROOT = resolve(__dirname, "..");
const DIRS = ["app", "components"];
const ALLOWED = /WORKEROS_|x-workeros|workeros_session/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

describe("visible brand rename", () => {
  it("has no capitalized legacy WorkerOS/Workeros display strings in app/components", () => {
    const offenders: string[] = [];
    for (const file of DIRS.flatMap((d) => walk(join(ROOT, d)))) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        const stripped = line.replace(ALLOWED, "");
        if (/WorkerOS|Workeros/.test(stripped)) {
          offenders.push(`${file.replace(ROOT, "")}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
