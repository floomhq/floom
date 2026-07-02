// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  me: vi.fn(),
  create: vi.fn(),
  select: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  setActiveWorkspaceId: vi.fn(),
  groupPostHogWorkspace: vi.fn(),
  toastError: vi.fn(),
  routerRefresh: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    workspace: {
      list: mocks.list,
      create: mocks.create,
      select: mocks.select,
      rename: vi.fn(),
      exportTemplate: vi.fn(),
      importTemplate: vi.fn(),
      duplicate: vi.fn(),
      shareLink: vi.fn(),
    },
    me: mocks.me,
  },
  getActiveWorkspaceId: mocks.getActiveWorkspaceId,
  setActiveWorkspaceId: mocks.setActiveWorkspaceId,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mocks.routerRefresh,
  }),
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
    mocks.select.mockReset();
    mocks.getActiveWorkspaceId.mockReset();
    mocks.setActiveWorkspaceId.mockReset();
    mocks.groupPostHogWorkspace.mockReset();
    mocks.toastError.mockReset();
    mocks.routerRefresh.mockReset();
    mocks.getActiveWorkspaceId.mockReturnValue(null);
    mocks.me.mockResolvedValue({ id: "u1", role: "owner" });
    mocks.select.mockResolvedValue({ id: "ws_1", name: "Acme", owner_user_id: "u1", created_at: "2026-06-01T00:00:00Z" });
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
    await user.click(await screen.findByText("New workspace"));
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

    expect(await screen.findByText("New workspace")).toBeInTheDocument();
  });

  it("switches workspaces in-place before any browser reload", async () => {
    mocks.list.mockResolvedValueOnce({
      active_id: "ws_2",
      workspaces: [
        { id: "ws_1", name: "Old workspace", owner_user_id: "u1", created_at: "2026-06-01T00:00:00Z" },
        { id: "ws_2", name: "New workspace", owner_user_id: "u1", created_at: "2026-06-02T00:00:00Z" },
      ],
    });
    const { WorkspaceSwitcher } = await import("@/components/layout/WorkspaceSwitcher");
    render(<WorkspaceSwitcher />);

    expect(await screen.findByText("New workspace")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Switch workspace" }));
    await user.click(await screen.findByText("Old workspace"));

    await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("ws_1"));
    expect(mocks.setActiveWorkspaceId).toHaveBeenCalledWith("ws_1");
    expect(mocks.routerRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Switch workspace" })).toHaveTextContent("Old workspace");
  });

  it("invalidates and refetches workspace-scoped queries after switching workspace", async () => {
    mocks.list.mockResolvedValueOnce({
      active_id: "ws_2",
      workspaces: [
        { id: "ws_1", name: "Old workspace", owner_user_id: "u1", created_at: "2026-06-01T00:00:00Z" },
        { id: "ws_2", name: "New workspace", owner_user_id: "u1", created_at: "2026-06-02T00:00:00Z" },
      ],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const removeSpy = vi.spyOn(queryClient, "removeQueries");
    const setDataSpy = vi.spyOn(queryClient, "setQueriesData");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const refetchSpy = vi.spyOn(queryClient, "refetchQueries");
    const { WorkspaceSwitcher } = await import("@/components/layout/WorkspaceSwitcher");

    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSwitcher />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("New workspace")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Switch workspace" }));
    await user.click(await screen.findByText("Old workspace"));

    await waitFor(() => expect(mocks.setActiveWorkspaceId).toHaveBeenCalledWith("ws_1"));
    for (const root of ["system", "workers", "runs", "contexts", "connections", "secrets", "approvals", "workspace"]) {
      expect(removeSpy).toHaveBeenCalledWith({ queryKey: [root], type: "inactive" });
      expect(setDataSpy).toHaveBeenCalledWith({ queryKey: [root], type: "active" }, expect.any(Function));
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: [root], refetchType: "none" });
      expect(refetchSpy).toHaveBeenCalledWith({ queryKey: [root], type: "active" });
    }
  });

  it("clears active list and object query payloads to non-stale empty values", async () => {
    const { clearedWorkspaceQueryData } = await import("@/lib/query/workspace");

    expect(clearedWorkspaceQueryData([{ id: "old-worker" }])).toEqual([]);
    expect(clearedWorkspaceQueryData({ pending: 3 })).toBeNull();
  });

  it("replaces stale URL workspace params before reload after a workspace switch", async () => {
    window.history.replaceState(null, "", "/workers?sel=w1&workspace_id=ws_old#source");
    const { replaceUrlWorkspaceParam } = await import("@/components/layout/WorkspaceSwitcher");

    replaceUrlWorkspaceParam("ws_new");

    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/workers?sel=w1&workspace_id=ws_new#source",
    );
  });

  it("normalizes legacy ws params before reload after a workspace switch", async () => {
    window.history.replaceState(null, "", "/workers?sel=w1&ws=ws_old");
    const { replaceUrlWorkspaceParam } = await import("@/components/layout/WorkspaceSwitcher");

    replaceUrlWorkspaceParam("ws_new");

    expect(window.location.pathname + window.location.search).toBe("/workers?sel=w1&workspace_id=ws_new");
  });
});
