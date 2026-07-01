// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  me: vi.fn(),
  create: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  groupPostHogWorkspace: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    workspace: {
      list: mocks.list,
      create: mocks.create,
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

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
  },
}));

describe("WorkspaceSwitcher cache", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.list.mockReset();
    mocks.me.mockReset();
    mocks.create.mockReset();
    mocks.getActiveWorkspaceId.mockReset();
    mocks.groupPostHogWorkspace.mockReset();
    mocks.toastError.mockReset();
    mocks.getActiveWorkspaceId.mockReturnValue(null);
    mocks.me.mockResolvedValue({ id: "u1", role: "owner" });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
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

  it("surfaces workspace create failures in the dialog", async () => {
    mocks.list.mockResolvedValueOnce({
      active_id: "ws_1",
      workspaces: [{ id: "ws_1", name: "Acme", owner_user_id: "u1", created_at: "2026-06-01T00:00:00Z" }],
    });
    mocks.create.mockRejectedValueOnce(new Error("a workspace named 'Acme' already exists"));

    const { WorkspaceSwitcher } = await import("@/components/layout/WorkspaceSwitcher");
    render(<WorkspaceSwitcher />);

    await screen.findByText("Acme");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Switch workspace" }));
    await user.click(screen.getByText("New workspace"));
    await user.type(screen.getByLabelText("Workspace name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(mocks.toastError).toHaveBeenCalledWith("a workspace named 'Acme' already exists");
  });

  it("keeps workspace creation available in cloud mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKEROS_DEPLOY", "cloud");
    mocks.list.mockResolvedValueOnce({
      active_id: "ws_1",
      workspaces: [{ id: "ws_1", name: "Acme", owner_user_id: "u1", created_at: "2026-06-01T00:00:00Z" }],
    });

    const { WorkspaceSwitcher } = await import("@/components/layout/WorkspaceSwitcher");
    render(<WorkspaceSwitcher />);

    await screen.findByText("Acme");
    await userEvent.setup().click(screen.getByRole("button", { name: "Switch workspace" }));

    expect(screen.getByText("New workspace")).toBeInTheDocument();
  });
});
