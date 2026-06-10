import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { list, create, remove } = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { workers: { feedback: { list, create, remove } } },
}));
vi.mock("@/lib/formatters", () => ({ formatRelative: () => "just now" }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { WorkerFeedbackPanel } from "@/components/worker/WorkerFeedbackPanel";

const item = {
  id: "fdbk_1",
  worker_id: "w1",
  author_id: "u1",
  author_name: "Federico",
  content: "Discord formatting is off.",
  created_at: "2026-06-09T12:00:00Z",
};

beforeEach(() => {
  list.mockReset().mockResolvedValue([item]);
  create.mockReset();
  remove.mockReset();
});

describe("WorkerFeedbackPanel", () => {
  it("lists existing feedback and posts a new comment", async () => {
    const user = userEvent.setup();
    create.mockResolvedValue({ ...item, id: "fdbk_2", content: "New note" });
    render(<WorkerFeedbackPanel workerId="w1" canLeave canModerate />);

    expect(await screen.findByText("Discord formatting is off.")).toBeInTheDocument();
    expect(screen.getByText("Federico")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Leave feedback"), "New note");
    await user.click(screen.getByRole("button", { name: /Post feedback/ }));

    expect(create).toHaveBeenCalledWith("w1", "New note");
    expect(await screen.findByText("New note")).toBeInTheDocument();
  });

  it("hides the compose box when the viewer cannot leave feedback", async () => {
    render(<WorkerFeedbackPanel workerId="w1" canLeave={false} />);
    expect(await screen.findByText("Discord formatting is off.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Leave feedback")).not.toBeInTheDocument();
  });

  it("shows delete only when allowed to moderate", async () => {
    remove.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<WorkerFeedbackPanel workerId="w1" canLeave canModerate />);
    const del = await screen.findByRole("button", { name: "Delete feedback" });
    await user.click(del);
    expect(remove).toHaveBeenCalledWith("w1", "fdbk_1");
  });
});
