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
      exportTemplate: vi.fn(),
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
  apiMock.membersList.mockResolvedValue({
    workspace_id: "w1",
    my_user_id: "u1",
    my_role: "admin",
    members: [],
  });
});

describe("Settings design-system register", () => {
  it("renders settings detail bodies as tokenized sections and rows without the old card idiom", async () => {
    const user = userEvent.setup();
    const { default: SettingsPage } = await import("@/app/settings/page");

    render(<SettingsPage />);

    // Settings renders grid-first; the section is selectable directly (no view toggle needed).
    const generalNav = await screen.findByText("General", {}, { timeout: 5000 });
    await user.click(generalNav);

    const body = await waitFor(() => {
      const el = document.querySelector("[data-settings-body]");
      expect(el).toBeTruthy();
      expect(el?.querySelector(".c-set-sec")).toBeTruthy();
      expect(el?.querySelector(".c-set-row")).toBeTruthy();
      return el as HTMLElement;
    }, { timeout: 3000 });

    expect(body).toHaveTextContent("System info");
    expect(body).toHaveTextContent("Version");

    // The meaningful §-rule: no old bordered grey CONTENT cards remain. (shadcn ui
    // primitives like Tabs legitimately use rounded-lg internally and pass lint:borders,
    // so we check settings CONTENT, not the whole subtree.)
    const oldContentCards = Array.from(body.querySelectorAll<HTMLElement>("*")).filter((el) => {
      const cls = el.className.toString();
      return /\bborder\b/.test(cls) && cls.includes("bg-card") && /\brounded/.test(cls);
    });
    expect(oldContentCards).toHaveLength(0);

    // And no settings register element (section/header/row) carries a banned radius.
    const bannedRadiusOnContent = Array.from(
      body.querySelectorAll<HTMLElement>(".c-set-sec, .c-set-sech, .c-set-row, [class*='bg-card']"),
    ).filter((el) => /\brounded-(lg|md|sm)\b/.test(el.className.toString()));
    expect(bannedRadiusOnContent).toHaveLength(0);
  });
});
