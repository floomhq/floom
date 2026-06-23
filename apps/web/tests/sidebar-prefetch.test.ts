import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("sidebar navigation prefetch", () => {
  it("disables Next route prefetches for persistent sidebar links", () => {
    const source = readFileSync(join(process.cwd(), "components/layout/sidebar.tsx"), "utf8");

    expect(source).toContain("prefetch={false}");
    expect(source).toContain('href="/chat?mode=create"');
    expect(source).toContain('href="/overview"');
    expect(source).toContain('href="/settings"');
  });
});
