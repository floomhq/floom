import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const apiMock = vi.hoisted(() => ({
  me: vi.fn(),
  workspaceList: vi.fn(),
  systemInfo: vi.fn(),
  platformConfig: vi.fn(),
  workspaceSettings: vi.fn(),
  workspaceAgent: vi.fn(),
  workspaceBasePersona: vi.fn(),
  workspaceInstructions: vi.fn(),
  workspaceTokensList: vi.fn(),
  membersList: vi.fn(),
}));

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
      tokens: {
        list: apiMock.workspaceTokensList,
        create: vi.fn(),
        revoke: vi.fn(),
      },
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
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/settings?sel=workspace_token");
  apiMock.me.mockResolvedValue({
    user_id: "u1",
    email: "admin@floom.dev",
    display_name: "Admin User",
    role: "admin",
    is_admin: true,
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
  apiMock.workspaceBasePersona.mockResolvedValue({ content: "Base persona", is_custom: false });
  apiMock.workspaceInstructions.mockResolvedValue("Workspace notes");
  apiMock.workspaceTokensList.mockResolvedValue([
    {
      id: "wt1",
      name: "shared-runner",
      created_by: "u1",
      created_at: "2026-06-01T00:00:00Z",
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    },
  ]);
  apiMock.membersList.mockResolvedValue({
    workspace_id: "w1",
    my_user_id: "u1",
    my_role: "admin",
    members: [],
  });
});

describe("Settings workspace token deeplink", () => {
  it("opens the workspace token pane from ?sel=workspace_token", async () => {
    const { default: SettingsPage } = await import("@/app/settings/page");

    render(<SettingsPage />);

    expect(await screen.findByText(/one shared token/i)).toBeInTheDocument();
    expect(screen.getByText("shared-runner")).toBeInTheDocument();
    expect(screen.queryByText(/personal access tokens are scoped to your account/i)).not.toBeInTheDocument();
  }, 15_000);
});
