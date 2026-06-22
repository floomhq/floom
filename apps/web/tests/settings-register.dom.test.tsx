import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

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

vi.mock("@/components/GitWorkspacePanel", () => ({ GitWorkspacePanel: () => <div>Git panel</div> }));
vi.mock("@/components/mcp/McpInstallPanel", () => ({ McpInstallPanel: () => <div>MCP install</div> }));
vi.mock("@/components/assistant/SlackConnect", () => ({ SlackConnect: () => <div>Slack connect</div> }));

vi.mock("@/lib/api", () => ({
  API_BASE: "/api/proxy",
  api: {
    me: apiMock.me,
    workspace: {
      list: apiMock.workspaceList,
      getSettings: apiMock.workspaceSettings,
      setSetting: vi.fn(),
      exportTemplate: vi.fn(),
      tokens: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), revoke: vi.fn() },
    },
    system: {
      info: apiMock.systemInfo,
      platformConfig: apiMock.platformConfig,
      workspaceAgent: apiMock.workspaceAgent,
      workspaceBasePersona: apiMock.workspaceBasePersona,
      workspaceInstructions: apiMock.workspaceInstructions,
      listWorkspaceVersions: vi.fn().mockResolvedValue([]),
      listWorkspaceBaseVersions: vi.fn().mockResolvedValue([]),
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
    slack: { claim: vi.fn(), bindingMe: vi.fn().mockResolvedValue({ linked: false }), unlink: vi.fn() },
    whatsapp: { claim: vi.fn(), bindingMe: vi.fn().mockResolvedValue({ linked: false }), unlink: vi.fn() },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/settings");
  apiMock.me.mockResolvedValue({ user_id: "u1", email: "admin@floom.dev", display_name: "Admin", role: "admin", is_admin: true });
  apiMock.workspaceList.mockResolvedValue({
    active_id: "w1",
    workspaces: [{ id: "w1", name: "Floom", owner_user_id: "u1", created_at: "2026-06-01T00:00:00Z" }],
  });
  apiMock.systemInfo.mockResolvedValue({
    version: "1.0.0",
    started_at: "2026-06-11T00:00:00Z",
    python_version: "3.12",
    runner: "e2b",
  });
  apiMock.platformConfig.mockResolvedValue({ required_count: 1, set_count: 1, all_required_set: true, missing: [] });
  apiMock.workspaceSettings.mockResolvedValue({});
  apiMock.workspaceAgent.mockResolvedValue({
    id: "emily",
    name: "Emily",
    model: "gpt-5-mini",
    system_prompt: "Compiled prompt",
    visibility: "workspace",
    permissions: { can_view: true, can_edit: true, can_share: true, can_delete: false, can_leave_feedback: false, is_owner: false },
  });
  apiMock.workspaceBasePersona.mockResolvedValue({ content: "Base persona", is_custom: false });
  apiMock.workspaceInstructions.mockResolvedValue("Workspace notes");
  apiMock.membersList.mockResolvedValue({ workspace_id: "w1", my_user_id: "u1", my_role: "admin", members: [] });
});

describe("Settings register DOM", () => {
  it("renders flat register sections and rows without rejected settings-card classes", async () => {
    const { default: SettingsPage } = await import("@/app/settings/page");
    const { container } = render(<SettingsPage />);

    await waitFor(() => expect(container.querySelector(".c-set-sech")).toHaveTextContent("System info"));
    await waitFor(() => expect(container.querySelector(".c-set-sec .c-set-row")).toBeTruthy());

    const row = container.querySelector(".c-set-sec .c-set-row");
    expect(row).toBeTruthy();
    expect(row?.querySelector(".t")).toBeTruthy();
    const tabBody = row?.closest("[data-settings-body]");
    expect(tabBody).toBeTruthy();
    expect(tabBody?.querySelector(".c-set-sec")).toBeTruthy();
    expect(tabBody?.querySelector(".c-set-row")).toBeTruthy();
    expect(tabBody?.innerHTML).not.toMatch(/rounded-(lg|md|sm)/);
    expect(tabBody?.innerHTML).not.toMatch(/rounded-\[var\(--radius-card\)\][^"]*(?:border|bg-card)|(?:border|bg-card)[^"]*rounded-\[var\(--radius-card\)\]/);

    const source = readFileSync(join(process.cwd(), "app/settings/page.tsx"), "utf-8");
    expect(source).not.toContain("CollectionView");
    expect(source).not.toContain("SettingsPageClient");
    expect(source).not.toMatch(/rounded-(lg|md|sm)/);
    expect(source).not.toMatch(/rounded-\[var\(--radius-card\)\]/);
    expect(source).not.toMatch(/border bg-card|bg-card p-/);
  });
});
