import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "..", "components", "emily", "EmilyChat.tsx"), "utf8");

describe("Emily worker mutation invalidation (#1786)", () => {
  it("treats create-from-prompt as a worker mutation", () => {
    expect(SRC).toContain("workers__create_from_prompt");
    expect(SRC).toContain('invalidateQueries({ queryKey: ["workers"] })');
  });
});
