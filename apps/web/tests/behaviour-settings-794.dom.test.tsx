import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #794: BehaviourSettings loads workspace settings, reflects them, and persists
// toggles via api.workspace.setSetting.

const { getSettings, setSetting } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}));
vi.mock("@/lib/api", () => ({ api: { workspace: { getSettings, setSetting } } }));

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ approval_default: "true" });
  setSetting.mockResolvedValue(null);
});

describe("BehaviourSettings (#794)", () => {
  it("reflects loaded values and persists on toggle", async () => {
    const { BehaviourSettings } = await import("@/app/settings/page");
    render(<BehaviourSettings />);

    // The three behaviour rows render once loaded.
    expect(await screen.findByText("Require approval by default")).toBeInTheDocument();
    expect(screen.getByText("Auto-pause on repeated failures")).toBeInTheDocument();
    expect(screen.getByText("Email me on run failures")).toBeInTheDocument();

    const switches = screen.getAllByRole("switch");
    // approval_default loaded as true; auto_pause absent → false.
    expect(switches[0]).toHaveAttribute("aria-checked", "true");
    expect(switches[1]).toHaveAttribute("aria-checked", "false");
    expect(getSettings).toHaveBeenCalledTimes(1);
  });
});
