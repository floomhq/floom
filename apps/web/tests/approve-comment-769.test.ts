import { describe, it, expect, vi, beforeEach } from "vitest";

// #769: approveApproval forwards the reviewer's comment to the right endpoint
// for each approval kind (run / agent_tool / destructive_delete).

const { approve, approveAgentTool, approveAction } = vi.hoisted(() => ({
  approve: vi.fn().mockResolvedValue({ status: "approved" }),
  approveAgentTool: vi.fn().mockResolvedValue({ status: "approved" }),
  approveAction: vi.fn().mockResolvedValue({ status: "approved" }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    runs: { approve },
    approvals: { approveAgentTool, approveAction },
  },
}));

import { approveApproval } from "@/lib/approvals/decision";
import type { ApprovalRow } from "@/lib/types";

function row(kind: string | null): ApprovalRow {
  return {
    id: "ap-1",
    run_id: "run-1",
    decision_input_json: kind ? JSON.stringify({ kind }) : null,
  } as unknown as ApprovalRow;
}

beforeEach(() => vi.clearAllMocks());

describe("approveApproval comment (#769)", () => {
  it("forwards the comment on a run approval", async () => {
    await approveApproval(row(null), "  ship it  ");
    // signature: approve(run_id, editedOutput, annotations, comment)
    expect(approve).toHaveBeenCalledWith("run-1", undefined, undefined, "ship it");
  });

  it("forwards the comment on an agent_tool approval", async () => {
    await approveApproval(row("agent_tool"), "looks good");
    expect(approveAgentTool).toHaveBeenCalledWith("ap-1", undefined, "looks good");
  });

  it("forwards the comment on a destructive_delete approval", async () => {
    await approveApproval(row("destructive_delete"), "ok");
    expect(approveAction).toHaveBeenCalledWith("ap-1", undefined, "ok");
  });

  it("sends undefined when the comment is blank", async () => {
    await approveApproval(row(null), "   ");
    expect(approve).toHaveBeenCalledWith("run-1", undefined, undefined, undefined);
  });

  it("sends undefined when no comment is given", async () => {
    await approveApproval(row(null));
    expect(approve).toHaveBeenCalledWith("run-1", undefined, undefined, undefined);
  });
});
