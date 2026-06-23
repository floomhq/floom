import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// #1807: run feedback stays a lightweight signal until the operator promotes a
// specific feedback item into a git-backed workspace issue.

const { listFeedback, createFeedback, createFeedbackIssue, toastSuccess, toastError } = vi.hoisted(() => ({
  listFeedback: vi.fn(),
  createFeedback: vi.fn(),
  createFeedbackIssue: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    runs: {
      feedback: { list: listFeedback, create: createFeedback },
      createFeedbackIssue,
    },
  },
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

const feedback = {
  id: "rfb_1",
  run_id: "run_abc",
  worker_id: "inbox-helper",
  author_id: "u1",
  author_name: "Operator",
  content: "Summarised the wrong thread",
  rating: "down",
  issue_id: null,
  created_at: "2026-06-21T20:00:00Z",
};

beforeEach(() => {
  listFeedback.mockReset().mockResolvedValue([]);
  createFeedback.mockReset();
  createFeedbackIssue.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("TrackRunFeedbackIssue", () => {
  it("saves run feedback, then promotes that feedback item to an issue", async () => {
    const user = userEvent.setup();
    createFeedback.mockResolvedValue(feedback);
    createFeedbackIssue.mockResolvedValue({
      issue_id: "ISSUE-0007",
      created: true,
      issue: { id: "ISSUE-0007" },
      feedback: { ...feedback, issue_id: "ISSUE-0007" },
    });
    render(<TrackRunFeedbackIssue run={run} />);

    await user.click(screen.getByRole("button", { name: /Feedback/ }));
    await user.type(screen.getByLabelText("Feedback"), "Summarised the wrong thread");
    await user.click(screen.getByRole("button", { name: /Save feedback/ }));
    await screen.findByText("Summarised the wrong thread");

    await user.click(screen.getByRole("button", { name: /Create issue/ }));

    expect(createFeedback).toHaveBeenCalledWith("run_abc", "Summarised the wrong thread");
    expect(createFeedbackIssue).toHaveBeenCalledWith("run_abc", {
      feedback_id: "rfb_1",
      title: null,
    });
    expect(toastSuccess).toHaveBeenCalledWith("Created ISSUE-0007");
    expect(await screen.findByText(/Tracked as ISSUE-0007/)).toBeInTheDocument();
  });

  it("passes an operator-supplied issue title when promoting feedback", async () => {
    const user = userEvent.setup();
    listFeedback.mockResolvedValue([feedback]);
    createFeedbackIssue.mockResolvedValue({
      issue_id: "ISSUE-0008",
      created: true,
      issue: { id: "ISSUE-0008" },
      feedback: { ...feedback, issue_id: "ISSUE-0008" },
    });
    render(<TrackRunFeedbackIssue run={run} />);

    await user.click(screen.getByRole("button", { name: /Feedback/ }));
    await screen.findByText("Summarised the wrong thread");
    await user.type(screen.getByLabelText("Issue title override (optional)"), "Mislabels threads");
    await user.click(screen.getByRole("button", { name: /Create issue/ }));

    expect(createFeedbackIssue).toHaveBeenCalledWith("run_abc", {
      feedback_id: "rfb_1",
      title: "Mislabels threads",
    });
  });

  it("does not save empty feedback", async () => {
    const user = userEvent.setup();
    render(<TrackRunFeedbackIssue run={run} />);
    await user.click(screen.getByRole("button", { name: /Feedback/ }));

    const submit = screen.getByRole("button", { name: /Save feedback/ });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(createFeedback).not.toHaveBeenCalled();
  });
});
