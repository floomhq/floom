import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// #791: workspace region/timezone/domain fields persist via workspace settings.

const { getSettings, setSetting } = vi.hoisted(() => ({ getSettings: vi.fn(), setSetting: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}));
vi.mock("@/lib/api", () => ({
  API_BASE: "/api/proxy",
  api: {
    me: vi.fn().mockResolvedValue({ role: "admin", is_admin: true }),
    workspace: {
      list: vi.fn().mockResolvedValue({ active_id: "w1", workspaces: [{ id: "w1", name: "Floom" }] }),
      getSettings,
      setSetting,
      tokens: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), revoke: vi.fn() },
    },
    system: {
      info: vi.fn().mockResolvedValue({ version: "1", started_at: "now", python_version: "3", runner: "local" }),
      platformConfig: vi.fn().mockResolvedValue({ required_count: 0, set_count: 0, all_required_set: true, missing: [] }),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/settings?sel=system&tab=workspace");
  getSettings.mockResolvedValue({ timezone: "America/New_York" });
  setSetting.mockResolvedValue(null);
});

describe("WorkspaceInfoSettings (#791)", () => {
  it("prefills and saves region on blur", async () => {
    const { default: SettingsPage } = await import("@/app/settings/page");
    render(<SettingsPage />);

    const tz = (await screen.findByLabelText("Timezone")) as HTMLInputElement;
    expect(tz.value).toBe("America/New_York");

    const region = screen.getByLabelText("Region") as HTMLInputElement;
    fireEvent.change(region, { target: { value: "eu-west" } });
    fireEvent.blur(region);
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("region", "eu-west"));
  });
});
