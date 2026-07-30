import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #1201: ModelDefaults renders workspace spend-to-date next to the monthly
// spend cap setting, sourced from the purpose-built GET /workspace/spend
// (api.workspace.getSpend), not parsed out of getSettings.

const { getSettings, setSetting, getSpend } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
  getSpend: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}));
vi.mock("@/lib/api", () => ({
  API_BASE: "/api/proxy",
  api: { workspace: { getSettings, setSetting, getSpend } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ monthly_spend_cap_usd: "50" });
  setSetting.mockResolvedValue(null);
});

describe("ModelDefaults spend readout (#1201)", () => {
  it("renders spend-to-date against the configured caps", async () => {
    getSpend.mockResolvedValue({
      day_spend_usd: 3.5,
      month_spend_usd: 12.75,
      daily_cap_usd: 5,
      monthly_cap_usd: 50,
    });
    const { ModelDefaults } = await import("@/app/settings/page");
    render(<ModelDefaults />);

    const readout = await screen.findByTestId("workspace-spend-readout");
    expect(readout.textContent).toContain("$12.75");
    expect(readout.textContent).toContain("$50.00");
    expect(readout.textContent).toContain("$3.50");
    expect(readout.textContent).toContain("$5.00");
    expect(getSpend).toHaveBeenCalledTimes(1);
  });

  it("shows 'no cap set' when the workspace has not configured a monthly cap", async () => {
    getSpend.mockResolvedValue({
      day_spend_usd: 0,
      month_spend_usd: 0,
      daily_cap_usd: null,
      monthly_cap_usd: null,
    });
    const { ModelDefaults } = await import("@/app/settings/page");
    render(<ModelDefaults />);

    const readout = await screen.findByTestId("workspace-spend-readout");
    expect(readout.textContent).toContain("no cap set");
  });

  it("does not render the readout while spend is still loading or failed", async () => {
    getSpend.mockRejectedValue(new Error("boom"));
    const { ModelDefaults } = await import("@/app/settings/page");
    render(<ModelDefaults />);

    // Fields still render even if the spend fetch fails.
    expect(await screen.findByText("Monthly spend cap (USD)")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-spend-readout")).not.toBeInTheDocument();
  });
});
