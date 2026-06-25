// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  me: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  groupPostHogWorkspace: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    workspace: {
      list: mocks.list,
      create: vi.fn(),
      select: vi.fn(),
      rename: vi.fn(),
      exportTemplate: vi.fn(),
      importTemplate: vi.fn(),
      duplicate: vi.fn(),
      shareLink: vi.fn(),
    },
    me: mocks.me,
  },
  getActiveWorkspaceId: mocks.getActiveWorkspaceId,
  setActiveWorkspaceId: vi.fn(),
}));

vi.mock("@/lib/posthog", () => ({
  groupPostHogWorkspace: mocks.groupPostHogWorkspace,
}));

describe("WorkspaceSwitcher cache", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.list.mockReset();
    mocks.me.mockReset();
    mocks.getActiveWorkspaceId.mockReset();
    mocks.groupPostHogWorkspace.mockReset();
    mocks.getActiveWorkspaceId.mockReturnValue(null);
    mocks.me.mockResolvedValue({ id: "u1", role: "owner" });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders cached workspace state immediately after a remount", async () => {
    mocks.list.mockResolvedValueOnce({
      active_id: "ws_1",
      workspaces: [{ id: "ws_1", name: "Acme", owner_user_id: "u1", created_at: "2026-06-01T00:00:00Z" }],
    });

    const { WorkspaceSwitcher } = await import("@/components/layout/WorkspaceSwitcher");
    const first = render(<WorkspaceSwitcher />);

    expect(screen.getByLabelText("Loading workspaces")).toBeInTheDocument();
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(1);

    first.unmount();
    mocks.list.mockImplementation(() => new Promise(() => {}));

    render(<WorkspaceSwitcher />);

    expect(screen.queryByLabelText("Loading workspaces")).not.toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
  });
});
