import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiMock = vi.hoisted(() => ({
  me: vi.fn(),
  workspaceList: vi.fn(),
  systemInfo: vi.fn(),
  platformConfig: vi.fn(),
  workspaceSettings: vi.fn(),
  workspaceAgent: vi.fn(),
  workspaceBasePersona: vi.fn(),
  workspaceInstructions: vi.fn(),
  membersList: vi.fn(),
}));

vi.mock("@/components/CliCommandPanel", () => ({ CliCommandPanel: () => <div>CLI panel</div> }));
vi.mock("@/components/GitWorkspacePanel", () => ({ GitWorkspacePanel: () => <div>Git panel</div> }));
vi.mock("@/components/assistant/SlackConnect", () => ({ SlackConnect: () => <div>Slack connect</div> }));

vi.mock("@/lib/api", () => ({
  API_BASE: "/api/proxy",
  api: {
    me: apiMock.me,
    workspace: {
      list: apiMock.workspaceList,
      getSettings: apiMock.workspaceSettings,
      setSetting: vi.fn(),
    },
    system: {
      info: apiMock.systemInfo,
      platformConfig: apiMock.platformConfig,
      workspaceAgent: apiMock.workspaceAgent,
      workspaceBasePersona: apiMock.workspaceBasePersona,
      workspaceInstructions: apiMock.workspaceInstructions,
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
      list: apiMock.membersList,
      invite: vi.fn(),
      setRole: vi.fn(),
      remove: vi.fn(),
      transferOwner: vi.fn(),
    },
    tokens: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), revoke: vi.fn() },
    slack: { claim: vi.fn(), bindingMe: vi.fn(), unlink: vi.fn(), installUrl: vi.fn(), setupStatus: vi.fn() },
    whatsapp: { claim: vi.fn(), bindingMe: vi.fn(), unlink: vi.fn() },
    workers: { reload: vi.fn() },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/settings");
  apiMock.me.mockResolvedValue({
    user_id: "u1",
    email: "member@floom.dev",
    display_name: "Member User",
    role: "member",
    is_admin: false,
  });
  apiMock.workspaceList.mockResolvedValue({
    active_id: "w1",
    workspaces: [{ id: "w1", name: "Floom", owner_user_id: "u0", created_at: "2026-06-01T00:00:00Z" }],
  });
  apiMock.systemInfo.mockResolvedValue({
    version: "1.0.0",
    started_at: "2026-06-11T00:00:00Z",
    python_version: "3.12",
    runner: "e2b",
  });
  apiMock.platformConfig.mockResolvedValue({
    required_count: 1,
    set_count: 1,
    all_required_set: true,
    missing: [],
  });
  apiMock.workspaceSettings.mockResolvedValue({});
  apiMock.workspaceAgent.mockResolvedValue({
    id: "emily",
    name: "Emily",
    model: "gpt-5-mini",
    system_prompt: "Compiled prompt",
    visibility: "workspace",
    permissions: {
      can_view: true,
      can_edit: true,
      can_share: true,
      can_delete: false,
      can_leave_feedback: false,
      is_owner: false,
    },
  });
  apiMock.workspaceBasePersona.mockResolvedValue({
    content: "Base persona",
    is_custom: false,
  });
  apiMock.workspaceInstructions.mockResolvedValue("Workspace notes");
  apiMock.membersList.mockResolvedValue({
    workspace_id: "w1",
    my_user_id: "u1",
    my_role: "member",
    members: [
      {
        workspace_id: "w1",
        user_id: "u1",
        email: "member@floom.dev",
        display_name: "Member User",
        role: "member",
        status: "active",
        invited_by: null,
        created_at: null,
        updated_at: null,
      },
    ],
  });
});

describe("Settings Collection (Phase 3)", () => {
  it("renders the grouped Settings collection and member read-only detail", async () => {
    const user = userEvent.setup();
    const { default: SettingsPage } = await import("@/app/settings/page");

    render(<SettingsPage />);

    expect(await screen.findByRole("button", { name: "Grid view", pressed: true })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "List view" }));
    await waitFor(() => expect(screen.getByText("General")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText("Workspace defaults")).toBeInTheDocument();
    expect(screen.getByText("Slack, email & WhatsApp")).toBeInTheDocument();
    expect(screen.getByText("Configure Emily")).toBeInTheDocument();
    expect(screen.getByText("People & roles")).toBeInTheDocument();
    expect(screen.getByText("Git-tracked workspace changelog")).toBeInTheDocument();
    expect(screen.getByText("Theme (light, dark, system)")).toBeInTheDocument();

    await user.click(screen.getByText("Members"));

    expect(await screen.findByText("Member management controls are hidden because this account is not Owner or Admin.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite" })).not.toBeInTheDocument();

    await user.click(screen.getByText("Assistant"));

    expect(await screen.findByText("Assistant editing controls are hidden because this account cannot edit workspace assistant settings.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("uses the workspace display fallback for UUID names and renders one Settings heading", async () => {
    const user = userEvent.setup();
    apiMock.workspaceList.mockResolvedValue({
      active_id: "w1",
      workspaces: [
        {
          id: "w1",
          name: "9b1a5065-3ab9-493a-8220-b6c139d9c1b7",
          owner_user_id: "u0",
          created_at: "2026-06-01T00:00:00Z",
        },
      ],
    });
    const { default: SettingsPage } = await import("@/app/settings/page");

    render(<SettingsPage />);

    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(await screen.findByText("Workspace · My workspace", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/9b1a5065-3ab9-493a-8220-b6c139d9c1b7/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Settings")).toHaveLength(1);
  });
});
