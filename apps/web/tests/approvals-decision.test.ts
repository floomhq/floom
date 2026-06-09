import { describe, it, expect } from "vitest";
import { parseDecisionInput, approvalKind } from "@/lib/approvals/decision";

describe("parseDecisionInput", () => {
  it("returns {} for null/invalid JSON", () => {
    expect(parseDecisionInput(null)).toEqual({});
    expect(parseDecisionInput("not json")).toEqual({});
  });
  it("parses valid JSON objects", () => {
    expect(parseDecisionInput('{"kind":"agent_tool","x":1}')).toEqual({ kind: "agent_tool", x: 1 });
  });
});

describe("approvalKind (dispatch key)", () => {
  it("detects destructive_delete", () => {
    expect(approvalKind({ decision_input_json: '{"kind":"destructive_delete"}' })).toBe(
      "destructive_delete",
    );
  });
  it("detects agent_tool", () => {
    expect(approvalKind({ decision_input_json: '{"kind":"agent_tool"}' })).toBe("agent_tool");
  });
  it("defaults to run-bound for anything else", () => {
    expect(approvalKind({ decision_input_json: undefined })).toBe("run");
    expect(approvalKind({ decision_input_json: "{}" })).toBe("run");
    expect(approvalKind({ decision_input_json: '{"kind":"something"}' })).toBe("run");
  });
});
