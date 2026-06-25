import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApprovalReviewBody } from "@/components/share/ApprovalReviewBody";
import type { ApprovalRow } from "@/lib/types";

function baseRow(extra: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "apr_1",
    run_id: "run_1",
    worker_id: "staging-gate",
    worker_name: "staging-gate",
    status: "pending",
    label: "Approve action",
    created_at: new Date().toISOString(),
    ...extra,
  };
}

function renderBody(approval: ApprovalRow) {
  return render(
    <ApprovalReviewBody
      approval={approval}
      actionLine="Approve action"
      index={0}
      total={1}
      onPrev={() => {}}
      onNext={() => {}}
      comment=""
      onComment={() => {}}
      approveKeepsComment={false}
      busy={false}
      onApprove={() => {}}
      onReject={() => {}}
    />,
  );
}

describe("approval review blocked error state", () => {
  it("does not present approve/reject controls for an errored proposed output with no decision required", () => {
    renderBody(
      baseRow({
        preview_type: "json",
        preview: JSON.stringify({
          status: "error",
          error: "missing STAGING_GATE_SSH_KEY",
          decision_required: false,
        }),
        decision_input_json: "{}",
      }),
    );

    expect(screen.getByText("Action blocked")).toBeInTheDocument();
    expect(screen.getAllByText("This action failed: missing STAGING_GATE_SSH_KEY").length).toBeGreaterThan(0);
    expect(screen.getByText("No approval or rejection is available because the proposed action is not awaiting a decision.")).toBeInTheDocument();
    expect(screen.queryByText("Approval requested")).toBeNull();
    expect(screen.queryByText("Awaiting your decision")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();

    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Decision Required")).toBeInTheDocument();
  });
});
