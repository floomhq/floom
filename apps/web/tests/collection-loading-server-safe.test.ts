import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components", "collection", "CollectionStates.tsx"),
  "utf8",
);

describe("collection route loading shell", () => {
  it("does not render client controls with function props from loading.tsx", () => {
    expect(source).not.toContain("@/components/ui/segmented-control");
    expect(source).not.toContain("@/components/ui/button");
    expect(source).not.toContain("onChange={() => {}}");
    expect(source).toContain('className="inline-flex rounded-[var(--radius-button)] bg-[var(--bg-2)] p-0.5"');
  });
});
