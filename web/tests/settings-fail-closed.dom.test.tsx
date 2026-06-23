import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  me,
  updateMe,
  workspaceList,
  systemInfo,
  platformConfig,
  workspaceSettings,
  workspaceAgent,
  workspaceBasePersona,
  workspaceInstructions,
  membersList,
  tokensList,
  toastSuccess,
  toastError,
} = vi.hoisted(() => ({
  me: vi.fn(),
  updateMe: vi.fn(),
  workspaceList: vi.fn(),
  systemInfo: vi.fn(),
  platformConfig: vi.fn(),
  workspaceSettings: vi.fn(),
  workspaceAgent: vi.fn(),
  workspaceBasePersona: vi.fn(),
  workspaceInstructions: vi.fn(),
  membersList: vi.fn(),
  tokensList: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: toastSuccess, error: toastError }),
}));

vi.mock("@/components/GitWorkspacePanel", () => ({ GitWorkspacePanel: () => <div>Git panel</div> }));
vi.mock("@/components/assistant/SlackConnect", () => ({ SlackConnect: () => <div>Slack connect</div> }));

vi.mock("@/lib/api", () => ({
  API_BASE: "/api/proxy",
  api: {
    me,
    updateMe,
    workspace: {
      list: workspaceList,
      getSettings: workspaceSettings,
      setSetting: vi.fn(),
    },
    system: {
      info: systemInfo,
      platformConfig,
      workspaceAgent,
      workspaceBasePersona,
      workspaceInstructions,
      listWorkspaceVersions: vi.fn(),
      listWorkspaceBaseVersions: vi.fn(),
      rollbackWorkspaceInstructions: vi.fn(),
      rollbackWorkspaceBasePersona: vi.fn(),
      updateWorkspaceBasePersona: vi.fn(),
      updateWorkspaceInstructions: vi.fn(),
      resetWorkspaceBasePersona: vi.fn(),
      setAssistantVisibility: vi.fn(),
      clearRuns: vi.fn(),
    },
    members: {
      list: membersList,
      invite: vi.fn(),
      setRole: vi.fn(),
      remove: vi.fn(),
      transferOwner: vi.fn(),
    },
    tokens: { list: tokensList, create: vi.fn(), revoke: vi.fn() },
    workspaceTokens: {},
    slack: { claim: vi.fn(), bindingMe: vi.fn(), unlink: vi.fn(), installUrl: vi.fn(), setupStatus: vi.fn() },
    whatsapp: { claim: vi.fn(), bindingMe: vi.fn(), unlink: vi.fn() },
    workers: { reload: vi.fn() },
  },
}));

function defaultUser() {
  return {
    user_id: "u1",
    email: "admin@floom.dev",
    display_name: "Admin User",
    role: "admin",
    is_admin: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/settings");
  me.mockResolvedValue(defaultUser());
  updateMe.mockResolvedValue({ ...defaultUser(), display_name: "Federico" });
  workspaceList.mockResolvedValue({
    active_id: "w1",
    workspaces: [{ id: "w1", name: "Floom", owner_user_id: "u1", created_at: "2026-06-01T00:00:00Z" }],
  });
  systemInfo.mockResolvedValue({
    version: "1.0.0",
    started_at: "2026-06-11T00:00:00Z",
    python_version: "3.12",
    runner: "e2b",
  });
  platformConfig.mockResolvedValue({
    required_count: 1,
    set_count: 1,
    all_required_set: true,
    missing: [],
  });
  workspaceSettings.mockResolvedValue({});
  workspaceAgent.mockResolvedValue({
    id: "emily",
    name: "Emily",
    model: "gpt-5-mini",
    system_prompt: "Compiled prompt",
    visibility: "workspace",
    permissions: { can_view: true, can_edit: true, can_share: true, can_delete: false },
  });
  workspaceBasePersona.mockResolvedValue({ content: "Base persona", is_custom: false });
  workspaceInstructions.mockResolvedValue("Workspace notes");
  membersList.mockResolvedValue({ workspace_id: "w1", my_user_id: "u1", my_role: "admin", members: [] });
  tokensList.mockResolvedValue([]);
});

async function renderSettings(path = "/settings") {
  window.history.replaceState(null, "", path);
  const { default: SettingsPage } = await import("@/app/settings/page");
  render(<SettingsPage />);
}

describe("Settings fail-closed audit fixes", () => {
  it("saves profile through the real API helper and only succeeds after it resolves", async () => {
    const user = userEvent.setup();
    await renderSettings("/settings?sel=profile");

    await screen.findByDisplayValue("Admin User");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateMe).toHaveBeenCalledWith("Admin User", "u1"));
    expect(toastSuccess).toHaveBeenCalledWith("Name updated");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("renders profile save errors without optimistic success", async () => {
    const user = userEvent.setup();
    updateMe.mockRejectedValueOnce(new Error("Profile endpoint failed"));
    await renderSettings("/settings?sel=profile");

    await screen.findByDisplayValue("Admin User");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Profile endpoint failed");
    expect(toastError).toHaveBeenCalledWith("Profile endpoint failed");
    expect(toastSuccess).not.toHaveBeenCalledWith("Name updated");
  });

  it("locks privileged settings when /me cannot verify the role", async () => {
    me.mockRejectedValueOnce(new Error("me failed"));
    await renderSettings("/settings?sel=danger");

    expect(await screen.findByText("Could not verify workspace permissions")).toBeInTheDocument();
    expect(screen.getByText(/Privileged controls are locked/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete all runs" })).not.toBeInTheDocument();
  });

  it("renders a retryable personal-token load error instead of removing the panel", async () => {
    tokensList.mockRejectedValueOnce(new Error("tokens failed"));
    await renderSettings("/settings?sel=personal_tokens");

    expect(await screen.findByText("Could not load personal access tokens")).toBeInTheDocument();
    expect(screen.getByText("tokens failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders a retryable system-info error instead of leaving skeletons forever", async () => {
    systemInfo.mockRejectedValueOnce(new Error("system failed"));
    await renderSettings("/settings?sel=system");

    expect(await screen.findByText("Could not load system information")).toBeInTheDocument();
    expect(screen.getByText("system failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
