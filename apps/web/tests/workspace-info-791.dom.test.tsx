import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// #791: workspace region/timezone/domain fields persist via workspace settings.

const { getSettings, setSetting } = vi.hoisted(() => ({ getSettings: vi.fn(), setSetting: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}));
vi.mock("@/lib/api", () => ({ API_BASE: "/api/proxy", api: { workspace: { getSettings, setSetting } } }));

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ timezone: "America/New_York" });
  setSetting.mockResolvedValue(null);
});

describe("WorkspaceInfoSettings (#791)", () => {
  it("prefills and saves region on blur", async () => {
    const { WorkspaceInfoSettings } = await import("@/app/settings/page");
    render(<WorkspaceInfoSettings />);

    const tz = (await screen.findByLabelText("Timezone")) as HTMLInputElement;
    expect(tz.value).toBe("America/New_York");

    const region = screen.getByLabelText("Region") as HTMLInputElement;
    fireEvent.change(region, { target: { value: "eu-west" } });
    fireEvent.blur(region);
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("region", "eu-west"));
  });
});
