import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// #824: it's "WorkerOS", never "Workeros", in every user-visible string.
// Package/identifiers stay lowercase (workeros_*, WORKEROS_*, the CLI command
// `workeros ...`) and the legacy `WorkerosMark` component identifier is allowed.
// This scan guards against new "Workeros" display strings slipping in.

const ROOT = resolve(__dirname, "..");
const DIRS = ["app", "components"];
const ALLOWED = /Workeros(Mark)/; // only the component identifier

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

describe("brand casing (#824)", () => {
  it("has no user-visible 'Workeros' outside the WorkerosMark identifier", () => {
    const offenders: string[] = [];
    for (const file of DIRS.flatMap((d) => walk(join(ROOT, d)))) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        // capital-W "Workeros" that is NOT "WorkerosMark"
        const stripped = line.replace(/Workeros(Mark)/g, "");
        if (/Workeros/.test(stripped)) {
          offenders.push(`${file.replace(ROOT, "")}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
