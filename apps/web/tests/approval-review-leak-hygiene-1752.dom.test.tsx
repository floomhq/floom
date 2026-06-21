import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApprovalReviewBody } from "@/components/share/ApprovalReviewBody";
import type { ApprovalRow } from "@/lib/types";

// #1752 — the SHARED approval-review surface is rendered to a recipient who may
// have no account, and the backend does NOT strip internal <REDACTED:...> /
// citation markers from `preview_payload` or `decision_input_json`. The client
// is therefore the only defense. Two render branches were bypassing
// `sanitizeOutputText`:
//   1. the email branch (preview_payload.{to,subject,body})
//   2. ApprovalActionItems / ItemRow (title, key/value entries, scalar items)
// These tests lock that NO marker survives to the DOM on either branch, with
// mixed/lower-case secret names too (the regex was previously uppercase-only).

function baseRow(extra: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "apr_1",
    run_id: "run_1",
    worker_id: "leaky-worker",
    worker_name: "leaky-worker",
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

function noRedactedInDom(container: HTMLElement) {
  // No internal marker (any case) should survive anywhere in the rendered tree.
  expect(container.textContent ?? "").not.toMatch(/<REDACTED/i);
}

describe("#1752 approval-review email branch", () => {
  it("strips <REDACTED:...> markers from preview_payload to/subject/body", () => {
    const { container } = renderBody(
      baseRow({
        type: "email",
        preview_payload: {
          to: "<REDACTED:apifyToken> jane@example.com",
          subject: "Q3 results <REDACTED:my_key>",
          body: "Hi Jane,\n\nPlease review <REDACTED:Mixed_Case> the attached.",
        },
      }),
    );
    expect(screen.getByText(/jane@example\.com/)).toBeTruthy();
    expect(screen.getByText(/Q3 results/)).toBeTruthy();
    expect(screen.getByText(/Please review the attached\./)).toBeTruthy();
    noRedactedInDom(container);
  });

  it("strips citation tokens from the email body", () => {
    const { container } = renderBody(
      baseRow({
        type: "email",
        preview_payload: {
          to: "ops@example.com",
          subject: "Report",
          body: "See citeturn0search3 the summary.",
        },
      }),
    );
    expect(container.textContent ?? "").not.toContain("turn0search3");
    noRedactedInDom(container);
  });
});

describe("#1752 approval-review ItemRow (decision_input_json) branch", () => {
  it("strips markers from object item title and key/value entries", () => {
    const { container } = renderBody(
      baseRow({
        preview: "",
        decision_input_json: JSON.stringify({
          action: "create_record",
          items: [
            {
              name: "<REDACTED:apifyToken> Acme Corp",
              role: "<REDACTED:my_key> Senior Engineer",
            },
          ],
        }),
      }),
    );
    expect(screen.getByText(/Acme Corp/)).toBeTruthy();
    expect(screen.getByText(/Senior Engineer/)).toBeTruthy();
    noRedactedInDom(container);
  });

  it("strips markers from a scalar item", () => {
    const { container } = renderBody(
      baseRow({
        preview: "",
        decision_input_json: JSON.stringify({
          action: "notify",
          items: ["<REDACTED:Mixed_Case> ping the channel"],
        }),
      }),
    );
    expect(screen.getByText(/ping the channel/)).toBeTruthy();
    noRedactedInDom(container);
  });
});
