import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApprovalCard } from "@/components/emily/cards/ApprovalCard";
import type { ApprovalCard as ApprovalCardType } from "@/lib/emily-chat-types";

// #825 inline approvals: decisions go through the real kind-aware dispatch.
// Rule #9: pending is calm grey "waiting", never amber.

const listMock = vi.fn();
const approveAgentTool = vi.fn().mockResolvedValue({});
const rejectAgentTool = vi.fn().mockResolvedValue({});

vi.mock("@/lib/api", () => ({
  api: {
    approvals: {
      list: (...a: unknown[]) => listMock(...a),
      approveAgentTool: (...a: unknown[]) => approveAgentTool(...a),
      rejectAgentTool: (...a: unknown[]) => rejectAgentTool(...a),
      approveAction: vi.fn(),
      rejectAction: vi.fn(),
    },
    runs: { approve: vi.fn(), reject: vi.fn() },
  },
}));

const PENDING_ROW = {
  id: "ap_1",
  run_id: "run_1",
  decision_input_json: JSON.stringify({ kind: "agent_tool" }),
};

function card(extra: Partial<ApprovalCardType> = {}): ApprovalCardType {
  return {
    callId: "c1",
    card_id: "card1",
    status: "pending_approval",
    kind: "approval",
    approvalId: "ap_1",
    workerName: "CRM updater",
    action: "Update 3 HubSpot records",
    approved: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([PENDING_ROW]);
});

describe("ApprovalCard", () => {
  it("pending is calm grey 'waiting' — no amber (rule #9)", () => {
    const { container } = render(<ApprovalCard card={card()} />);
    expect(screen.getByText("waiting")).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/amber/);
    expect(screen.getByPlaceholderText(/Add a comment/)).toBeTruthy();
  });

  it("Approve dispatches via the kind-aware API and flips to Approved", async () => {
    render(<ApprovalCard card={card()} />);
    fireEvent.click(screen.getByText("Approve"));
    // #769: approveApproval forwards (id, editedOutput, comment) — no comment typed here.
    await waitFor(() => expect(approveAgentTool).toHaveBeenCalledWith("ap_1", undefined, undefined));
    await waitFor(() => expect(screen.getByText("Approved")).toBeTruthy());
  });

  it("Reject sends the comment as the reason", async () => {
    render(<ApprovalCard card={card()} />);
    fireEvent.change(screen.getByPlaceholderText(/Add a comment/), {
      target: { value: "wrong record set" },
    });
    fireEvent.click(screen.getByText("Reject"));
    await waitFor(() =>
      expect(rejectAgentTool).toHaveBeenCalledWith("ap_1", "wrong record set")
    );
    await waitFor(() => expect(screen.getByText("Rejected")).toBeTruthy());
  });

  it("stale approval (gone from pending) records no decision", async () => {
    listMock.mockResolvedValue([]);
    render(<ApprovalCard card={card()} />);
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(approveAgentTool).not.toHaveBeenCalled();
    expect(screen.getByText("waiting")).toBeTruthy(); // still pending locally
  });

  it("without an approvalId no API is touched", async () => {
    render(<ApprovalCard card={card({ approvalId: undefined })} />);
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(listMock).not.toHaveBeenCalled());
  });
});
