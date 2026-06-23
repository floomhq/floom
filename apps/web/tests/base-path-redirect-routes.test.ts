import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routeFiles = [
  "app/workers/new/page.tsx",
  "app/workers/[id]/page.tsx",
  "app/runs/[id]/page.tsx",
  "app/connections/[id]/page.tsx",
  "app/connections/mcp/[id]/page.tsx",
  "app/connections/slack/page.tsx",
  "app/members/page.tsx",
  "app/secrets/page.tsx",
];

describe("basePath-safe app redirects", () => {
  it("wraps legacy server redirects with appPath for cloud /app deploys", () => {
    for (const rel of routeFiles) {
      const source = readFileSync(join(process.cwd(), rel), "utf8");

      expect(source, rel).toContain('from "@/lib/app-path"');
      expect(source, rel).toContain("redirect(appPath(");
    }
  });
});
