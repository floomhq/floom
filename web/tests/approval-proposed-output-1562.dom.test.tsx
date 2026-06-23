import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApprovalReviewBody } from "@/components/share/ApprovalReviewBody";
import type { ApprovalRow } from "@/lib/types";

// #1562: the approval-detail "Proposed output" column rendered EMPTY whenever the
// worker emitted a plain `preview` string and no structured action items. Root
// cause: ProposedOutput branched on `<ApprovalActionItems/>` (a JSX element is
// always truthy) so the preview + empty-state fallback were dead code. These
// tests lock the three render paths.

function baseRow(extra: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "apr_1",
    run_id: "run_1",
    worker_id: "race-hitl-toctou",
    worker_name: "race-hitl-toctou",
    status: "pending",
    label: "Approve before sending",
    created_at: new Date().toISOString(),
    ...extra,
  };
}

function renderBody(approval: ApprovalRow) {
  return render(
    <ApprovalReviewBody
      approval={approval}
      actionLine="Approve before sending"
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

describe("#1562 approval proposed output", () => {
  it("renders the preview string when there are no structured items (the regression)", () => {
    renderBody(
      baseRow({
        preview: "draft for Test Prospect Beta",
        decision_input_json: JSON.stringify({ decision: "reject", prospect_name: "Test Prospect Beta" }),
      }),
    );
    expect(screen.getByText("draft for Test Prospect Beta")).toBeTruthy();
    expect(screen.queryByText("No proposed output attached to this request.")).toBeNull();
  });

  it("renders structured action items when the decision input carries an array", () => {
    renderBody(
      baseRow({
        preview: "",
        decision_input_json: JSON.stringify({
          action: "post_note",
          items: [{ name: "Acme Corp", note: "follow up" }],
        }),
      }),
    );
    expect(screen.getByText("Acme Corp")).toBeTruthy();
  });

  it("shows the empty-state placeholder only when genuinely empty", () => {
    renderBody(baseRow({ preview: "   ", decision_input_json: "{}" }));
    expect(screen.getByText("No proposed output attached to this request.")).toBeTruthy();
  });
});