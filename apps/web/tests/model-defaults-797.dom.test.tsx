import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// #797: ModelDefaults loads workspace settings, prefills fields, and persists
// edits on blur via api.workspace.setSetting.

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
  getSettings.mockResolvedValue({ default_model: "claude-opus-4-8" });
  setSetting.mockResolvedValue(null);
});

describe("ModelDefaults (#797)", () => {
  it("prefills from settings and saves on blur", async () => {
    const { ModelDefaults } = await import("@/app/settings/page");
    render(<ModelDefaults />);

    const modelInput = (await screen.findByLabelText("Default model")) as HTMLInputElement;
    expect(modelInput.value).toBe("claude-opus-4-8");

    const capInput = screen.getByLabelText("Monthly spend cap (USD)") as HTMLInputElement;
    fireEvent.change(capInput, { target: { value: "100" } });
    fireEvent.blur(capInput);
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("spend_cap_usd", "100"));
  });
});
