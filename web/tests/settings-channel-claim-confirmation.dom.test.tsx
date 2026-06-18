import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const claimWhatsApp = vi.fn(async () => ({}));
const claimSlack = vi.fn(async () => ({}));

vi.mock("@/lib/api", () => ({
  API_BASE: "https://api.example.test",
  api: {
    me: vi.fn(async () => ({ id: "user-1", email: "u@example.com", is_admin: true })),
    workspace: { list: vi.fn(async () => ({ workspaces: [], active_id: null })) },
    system: {
      info: vi.fn(async () => ({})),
      platformConfig: vi.fn(async () => ({})),
    },
    whatsapp: {
      claim: claimWhatsApp,
      bindingMe: vi.fn(async () => ({ linked: false })),
    },
    slack: {
      claim: claimSlack,
      bindingMe: vi.fn(async () => ({ linked: false })),
    },
  },
}));

vi.mock("@/components/collection/CollectionView", () => ({
  CollectionView: () => <div data-testid="settings-collection" />,
}));
vi.mock("@/components/GitWorkspacePanel", () => ({ GitWorkspacePanel: () => null }));
vi.mock("@/components/ThemeModeToggleGroup", () => ({ ThemeModeToggleGroup: () => null }));
vi.mock("@/components/assistant/SlackConnect", () => ({ SlackConnect: () => null }));
vi.mock("@/components/channels/ClaimSuccessOverlay", () => ({
  ClaimSuccessOverlay: ({ channel }: { channel: string }) => <div>Linked {channel}</div>,
}));
vi.mock("@/components/VersionHistoryMenu", () => ({ VersionHistoryMenu: () => null }));
vi.mock("@/components/AssetVisibilityControl", () => ({ AssetVisibilityControl: () => null }));
vi.mock("@/components/emily/EmilyAvatar", () => ({ EmilyAvatar: () => null }));
vi.mock("@/lib/notify", () => ({ reportError: vi.fn() }));

afterEach(() => {
  claimWhatsApp.mockClear();
  claimSlack.mockClear();
  window.history.replaceState(null, "", "/settings");
});

describe("settings channel claim confirmation", () => {
  it("does not claim a WhatsApp URL token until the user confirms", async () => {
    window.history.replaceState(null, "", "/settings?whatsapp_claim=claim-token");
    const { default: SettingsPage } = await import("@/app/settings/page");

    render(<SettingsPage />);

    expect(await screen.findByText("Confirm WhatsApp number link")).toBeInTheDocument();
    expect(claimWhatsApp).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Link WhatsApp" }));

    expect(claimWhatsApp).toHaveBeenCalledWith("claim-token");
  });
});
