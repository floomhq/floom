import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkerShareCard } from "@/components/share/WorkerShareCard";
import type { PublicWorker } from "@/lib/types";

// Use vi.hoisted so these refs are available inside vi.mock factory (hoisted).
const { mockRouterPush, mockSetActiveWorkspaceId, mockImportFromShare } = vi.hoisted(() => ({
  mockRouterPush: vi.fn(),
  mockSetActiveWorkspaceId: vi.fn(),
  mockImportFromShare: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    workers: {
      importFromShare: mockImportFromShare,
    },
  },
  setActiveWorkspaceId: mockSetActiveWorkspaceId,
}));

const worker: PublicWorker = {
  id: "w_linear_triage",
  name: "Linear Triage",
  description: "Prioritises Linear issues for review.",
  use_cases: ["Review stale bugs", "Summarise escalations", "Assign urgent tickets"],
  how_it_works: "Reads Linear issues and prepares a ranked triage brief.",
  is_example: false,
  tags: [],
  example_input: null,
  example_output: "",
  trigger_type: "schedule",
  runtime: "skill",
  connections: ["linear"],
  inputs: [
    {
      name: "team",
      label: "Team",
      type: "string",
      required: true,
      description: null,
    },
  ],
  outputs: [
    {
      name: "brief",
      label: "Brief",
      type: "markdown",
    },
  ],
};

describe("WorkerShareCard public panes", () => {
  it("preserves the public share path through login for logged-out imports", () => {
    render(<WorkerShareCard worker={worker} authed={false} token="spendready-lead-ops" />);

    expect(screen.getByRole("link", { name: "Add to workspace" })).toHaveAttribute(
      "href",
      "/login?next=%2Fs%2Fspendready-lead-ops",
    );
  });

  it("shows overview details plus copyable setup instead of a raw worker.yml tab", () => {
    const { container } = render(<WorkerShareCard worker={worker} authed={false} token="share_token" />);

    expect(screen.queryByRole("button", { name: "worker.yml" })).not.toBeInTheDocument();

    expect(screen.getAllByText("Runs on a schedule").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Tools used")).toBeInTheDocument();
    expect(screen.getAllByText("linear").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('use[href="#brand-linear"]')).toBeTruthy();
    expect(screen.getByText("Inputs")).toBeInTheDocument();
    expect(screen.getByText("team")).toBeInTheDocument();
    expect(screen.getByText("string")).toBeInTheDocument();
    expect(screen.getByText("required")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Setup" }));

    expect(screen.getByText("Agent install prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeInTheDocument();
    expect(screen.getByText("Worker setup")).toBeInTheDocument();
    expect(screen.getByText(/name: Linear Triage/)).toBeInTheDocument();
    expect(screen.getByText(/brief: markdown/)).toBeInTheDocument();
  });
});

describe("WorkerShareCard import workspace pickup (L6)", () => {
  it("calls setActiveWorkspaceId with response workspace_id before routing", async () => {
    mockImportFromShare.mockResolvedValueOnce({
      worker_id: "wk_abc123",
      url: "/workers/wk_abc123",
      workspace_id: "ws_new456",
    });
    mockRouterPush.mockClear();
    mockSetActiveWorkspaceId.mockClear();

    render(<WorkerShareCard worker={worker} authed token="share_abc" />);

    fireEvent.click(screen.getByRole("button", { name: /add to workspace/i }));

    await waitFor(() => {
      expect(mockSetActiveWorkspaceId).toHaveBeenCalledWith("ws_new456");
    });
    expect(mockRouterPush).toHaveBeenCalledWith(expect.stringContaining("wk_abc123"));
  });

  it("still routes when workspace_id is absent (non-cloud / existing user)", async () => {
    mockImportFromShare.mockResolvedValueOnce({
      worker_id: "wk_def789",
      url: "/workers/wk_def789",
    });
    mockRouterPush.mockClear();
    mockSetActiveWorkspaceId.mockClear();

    render(<WorkerShareCard worker={worker} authed token="share_def" />);

    fireEvent.click(screen.getByRole("button", { name: /add to workspace/i }));

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith(expect.stringContaining("wk_def789"));
    });
    // setActiveWorkspaceId must NOT be called when workspace_id is absent
    expect(mockSetActiveWorkspaceId).not.toHaveBeenCalled();
  });
});
