import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitAppInstallStart: vi.fn(),
  gitPush: vi.fn(),
  gitDisconnect: vi.fn(),
  gitConnect: vi.fn(),
  gitListRepos: vi.fn(),
  gitCreateRepo: vi.fn(),
  gitLink: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    system: apiMock,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.gitStatus.mockResolvedValue({ connected: false });
  apiMock.gitAppInstallStart.mockResolvedValue({ install_url: "https://github.com/apps/floom/installations/new" });
  apiMock.gitPush.mockResolvedValue({ connected: true });
  apiMock.gitDisconnect.mockResolvedValue(undefined);
  apiMock.gitConnect.mockResolvedValue({ username: "octocat" });
  apiMock.gitListRepos.mockResolvedValue([]);
  apiMock.gitCreateRepo.mockResolvedValue({ full_name: "octocat/workspace", name: "workspace", url: "", private: true });
  apiMock.gitLink.mockResolvedValue({ connected: true, repo_full_name: "octocat/workspace" });
});

describe("GitWorkspacePanel GitHub App connect UI", () => {
  it("shows the non-developer GitHub connect path first and keeps token setup advanced", async () => {
    const { GitWorkspacePanel } = await import("@/components/GitWorkspacePanel");

    render(<GitWorkspacePanel canManageWorkspace />);

    expect(await screen.findByRole("button", { name: "Connect GitHub" })).toBeInTheDocument();
    expect(screen.getByText("Back up your workspace to a private GitHub repo. Free.")).toBeInTheDocument();
    expect(screen.getByText("Advanced: use a token instead")).toBeInTheDocument();
    expect(screen.getByText("Create a token on GitHub")).not.toBeVisible();
  });

  it("shows connected backup status and puts disconnect under Advanced", async () => {
    const user = userEvent.setup();
    apiMock.gitStatus.mockResolvedValue({
      connected: true,
      github_username: "octocat",
      repo_full_name: "octocat/workspace",
      repo_url: "https://github.com/octocat/workspace",
      last_pushed_at: "2026-06-22T00:00:00Z",
    });
    const { GitWorkspacePanel } = await import("@/components/GitWorkspacePanel");

    render(<GitWorkspacePanel canManageWorkspace />);

    expect(await screen.findByText("Connected to octocat/workspace")).toBeInTheDocument();
    expect(screen.getByText(/Automatic workspace backups are on/)).toBeInTheDocument();
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    expect(disconnect).not.toBeVisible();

    await user.click(screen.getByText("Advanced"));
    expect(disconnect).toBeVisible();
    expect(screen.getByRole("button", { name: "Back up now" })).toBeVisible();
  });

  it("keeps members read-only", async () => {
    const { GitWorkspacePanel } = await import("@/components/GitWorkspacePanel");

    render(<GitWorkspacePanel canManageWorkspace={false} />);

    expect(await screen.findByText("GitHub is not connected for this workspace. Ask a workspace admin to connect GitHub in Settings.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).not.toBeInTheDocument();
  });
});
