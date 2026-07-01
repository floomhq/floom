import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "app", "workers", "WorkersCollection.tsx"),
  "utf8",
);

describe("worker Source tab static layout", () => {
  it("does not render the redundant file-list summary above the Files panel", () => {
    expect(source).not.toContain("ordered.map((file) => file.path).slice(0, 4).join");
    expect(source).toContain('<DetailGroup label="Source">');
    expect(source).toContain("<FilesEditor");
  });
});
