import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "app", "connections", "ConnectionsCollection.tsx"),
  "utf8",
);

describe("connection secret value field", () => {
  it("does not expose a fake reveal control for write-only values", () => {
    expect(source).toContain("Secret values are write-only and not returned by the API");
    expect(source).toContain("Copy secret name");
    expect(source).not.toContain("Reveal:");
    expect(source).not.toContain("setRevealed");
    expect(source).not.toContain("EyeOff");
  });
});
