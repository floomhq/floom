import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "..", "app", "workers", "WorkersCollection.tsx"), "utf8");

describe("worker Versions restore confirmation (#1594)", () => {
  it("uses the shared ConfirmDialog instead of native window.confirm", () => {
    expect(SRC).toContain("ConfirmDialog");
    expect(SRC).not.toMatch(/\bwindow\.confirm\s*\(/);
  });
});
