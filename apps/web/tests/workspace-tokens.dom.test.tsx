import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Workspace token (wst_): admin-only token panel in Settings. List/create
// (show-once value)/revoke via api.workspace.tokens; members get 403 and see
// the admins-only notice.

const { list, create, revoke } = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}));
vi.mock("@/lib/api", () => ({
  API_BASE: "/api/proxy",
  api: { workspace: { tokens: { list, create, revoke } } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([
    {
      id: "wt1",
      name: "shared-runner",
      created_by: "u1",
      created_at: "2026-06-01T00:00:00Z",
      last_used_at: "2026-06-10T00:00:00Z",
      expires_at: null,
      revoked_at: null,
    },
  ]);
  create.mockResolvedValue({
    id: "wt2",
    name: "ci",
    token: "wst_abc123secret",
    expires_at: null,
  });
  revoke.mockResolvedValue(null);
});

describe("WorkspaceTokensPanel", () => {
  it("lists workspace tokens by name", async () => {
    const { WorkspaceTokensPanel } = await import("@/app/settings/page");
    render(<WorkspaceTokensPanel />);
    expect(await screen.findByText("shared-runner")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(1);
    // Explainer copy is present.
    expect(
      screen.getByText(/workspace-shared workers only/)
    ).toBeInTheDocument();
  });

  it("create flow shows the one-time token value", async () => {
    const { WorkspaceTokensPanel } = await import("@/app/settings/page");
    render(<WorkspaceTokensPanel />);
    await screen.findByText("shared-runner");

    fireEvent.change(screen.getByPlaceholderText(/Token name/), {
      target: { value: "ci" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith("ci"));
    expect(await screen.findByText("wst_abc123secret")).toBeInTheDocument();
    expect(screen.getByText(/won.t be shown again/)).toBeInTheDocument();
  });

  it("revoke calls the api with the token id", async () => {
    const { WorkspaceTokensPanel } = await import("@/app/settings/page");
    render(<WorkspaceTokensPanel />);
    await screen.findByText("shared-runner");

    fireEvent.click(screen.getByRole("button", { name: "Revoke shared-runner" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("wt1"));
  });

  it("403 from list shows the admins-only message", async () => {
    list.mockRejectedValue(new Error("Admin role required"));
    const { WorkspaceTokensPanel } = await import("@/app/settings/page");
    render(<WorkspaceTokensPanel />);
    expect(
      await screen.findByText("Only workspace admins can manage the workspace token.")
    ).toBeInTheDocument();
    // Panel content (create form) is hidden for members.
    expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
  });
});
