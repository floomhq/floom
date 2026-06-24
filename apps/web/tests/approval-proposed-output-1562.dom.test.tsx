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

  // Approval-review side-pane bug: in the narrow detail pane the proposed-output
  // key/value list crushed values to ~4-5 chars per line (e.g. an Audit Job Id
  // wrapped as "2026 / 0623T / 2359 / ..."). Root cause: the KV grid used a
  // VIEWPORT `sm:` breakpoint + a 180px key column, so a wide viewport with a
  // narrow pane still gave the key 180px and starved the value. The fix keys the
  // layout off the CONTAINER width via a container query.
  it("renders a JSON-object proposed output as a key/value list that keeps the full value", () => {
    const { container } = renderBody(
      baseRow({
        preview: JSON.stringify({
          audit_job_id: "20260623T235947Z-12f591be69bf",
          status: "audit_started",
          decision_required: false,
        }),
        preview_type: "json",
        decision_input_json: "{}",
      }),
    );
    // Humanized keys render.
    expect(screen.getByText("Audit Job Id")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    // The long token is present in FULL (not split into char-level fragments).
    expect(screen.getByText("20260623T235947Z-12f591be69bf")).toBeTruthy();
    expect(screen.getByText("audit_started")).toBeTruthy();
    // The two-column layout is gated on the CONTAINER (a container-query
    // wrapper + `@sm:` grid), never a bare viewport `sm:` breakpoint.
    const cq = container.querySelector(".\\@container");
    expect(cq).not.toBeNull();
    const dl = cq?.querySelector("dl");
    expect(dl).not.toBeNull();
    expect(dl?.className).toContain("@sm:grid-cols-");
    expect(dl?.className).not.toMatch(/(^|\s)sm:grid-cols-/);
  });
});