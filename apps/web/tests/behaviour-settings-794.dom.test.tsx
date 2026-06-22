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
  window.history.replaceState(null, "", "/settings?sel=system&tab=behaviour");
  getSettings.mockResolvedValue({ approval_default: "true" });
  setSetting.mockResolvedValue(null);
});

describe("BehaviourSettings (#794)", () => {
  it("reflects loaded values and persists on toggle", async () => {
    const { default: SettingsPage } = await import("@/app/settings/page");
    render(<SettingsPage />);

    // The three behaviour rows render once loaded.
    expect(await screen.findByText("Require approval by default")).toBeInTheDocument();
    expect(screen.getByText("Auto-pause on repeated failures")).toBeInTheDocument();
    expect(screen.getByText("Email me on run failures")).toBeInTheDocument();

    const switches = screen.getAllByRole("switch");
    // approval_default loaded as true; auto_pause absent → false.
    expect(switches[0]).toHaveAttribute("aria-checked", "true");
    expect(switches[1]).toHaveAttribute("aria-checked", "false");
    expect(getSettings).toHaveBeenCalled();
  });
});

// #794 — the toggle keys MUST match what the backend reads. run_service.py
// reads "auto_pause_enabled"; the UI originally wrote "auto_pause" and the
// toggle silently did nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("#794 workspace toggle keys match backend enforcement", () => {
  it("writes auto_pause_enabled / failure_email_enabled / approval_default", () => {
    const src = readFileSync(join(process.cwd(), "app/settings/page.tsx"), "utf-8");
    expect(src).toContain('key: "auto_pause_enabled"');
    expect(src).toContain('key: "failure_email_enabled"');
    expect(src).toContain('key: "approval_default"');
    // The dead key must not come back.
    expect(src).not.toMatch(/key: "auto_pause"[^_]/);
  });
});
