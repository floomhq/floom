import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// #1807: the "Track as issue" control converts actionable run feedback into a
// git-backed workspace issue and confirms the created id inline + via toast.

const { createFeedbackIssue, toastSuccess, toastError } = vi.hoisted(() => ({
  createFeedbackIssue: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { runs: { createFeedbackIssue } },
}));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

import { TrackRunFeedbackIssue } from "@/components/RunDetailSplitPane";
import type { RunDetail } from "@/lib/types";

const run = {
  id: "run_abc",
  worker_id: "inbox-helper",
  worker_name: "Inbox Helper",
  status: "completed",
} as unknown as RunDetail;

beforeEach(() => {
  createFeedbackIssue.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("TrackRunFeedbackIssue", () => {
  it("creates an issue from feedback and confirms the id", async () => {
    const user = userEvent.setup();
    createFeedbackIssue.mockResolvedValue({
      issue_id: "ISSUE-0007",
      created: true,
      issue: { id: "ISSUE-0007" },
    });
    render(<TrackRunFeedbackIssue run={run} />);

    await user.click(screen.getByRole("button", { name: /Track as issue/ }));
    await user.type(screen.getByLabelText("What went wrong?"), "Summarised the wrong thread");
    await user.click(screen.getByRole("button", { name: /Create issue/ }));

    expect(createFeedbackIssue).toHaveBeenCalledWith("run_abc", {
      feedback_text: "Summarised the wrong thread",
      title: null,
    });
    expect(toastSuccess).toHaveBeenCalledWith("Created ISSUE-0007");
    expect(await screen.findByText("ISSUE-0007")).toBeInTheDocument();
  });

  it("passes an operator-supplied title through", async () => {
    const user = userEvent.setup();
    createFeedbackIssue.mockResolvedValue({
      issue_id: "ISSUE-0008",
      created: true,
      issue: { id: "ISSUE-0008" },
    });
    render(<TrackRunFeedbackIssue run={run} />);

    await user.click(screen.getByRole("button", { name: /Track as issue/ }));
    await user.type(screen.getByLabelText("Title (optional)"), "Mislabels threads");
    await user.type(screen.getByLabelText("What went wrong?"), "bad");
    await user.click(screen.getByRole("button", { name: /Create issue/ }));

    expect(createFeedbackIssue).toHaveBeenCalledWith("run_abc", {
      feedback_text: "bad",
      title: "Mislabels threads",
    });
  });

  it("does not submit empty feedback", async () => {
    const user = userEvent.setup();
    render(<TrackRunFeedbackIssue run={run} />);
    await user.click(screen.getByRole("button", { name: /Track as issue/ }));

    const submit = screen.getByRole("button", { name: /Create issue/ });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(createFeedbackIssue).not.toHaveBeenCalled();
  });
});
