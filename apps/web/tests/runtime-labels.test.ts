import { describe, expect, it } from "vitest";
import { modelLabel } from "@/lib/model-labels";
import { runtimeKindLabel, runnerLabel, runtimeSummary } from "@/lib/runtime-labels";

describe("runtime/model friendly labels", () => {
  it("formats runner/runtime ids without leaking raw engine ids into Config", () => {
    expect(runnerLabel("e2b")).toBe("E2B sandbox");
    expect(runtimeKindLabel("python311")).toBe("Python 3.11");
    expect(runtimeKindLabel("node22")).toBe("Node.js 22");
    expect(runtimeSummary({ runner: "e2b", runtime: "skill" })).toBe("E2B sandbox · Agent skill");
  });

  it("formats provider model ids as friendly names", () => {
    expect(modelLabel("bedrock/us.anthropic.claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(modelLabel("gpt-5-mini")).toBe("GPT-5 Mini");
  });
});
