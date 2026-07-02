import { describe, it, expect } from "vitest";
import {
  SETTINGS_NAV,
  settingsGroup,
  settingsCounts,
  groupLabel,
} from "@/lib/settings/nav-groups";

// Historical 8-item Settings IA: six workspace rows and two account rows.
// Developer consolidates programmatic access (personal tokens, workspace token,
// API, MCP, CLI, Git) so Settings stays scannable at the top level.

describe("Settings nav groups", () => {
  it("keeps workspace settings to six top-level rows", () => {
    expect(settingsGroup("workspace").map((i) => i.label)).toEqual([
      "General",
      "Members",
      "Channels",
      "Assistant",
      "Backups & history",
      "Danger zone",
    ]);
  });

  it("keeps account settings to two top-level rows", () => {
    expect(settingsGroup("account").map((i) => i.label)).toEqual([
      "Developer",
      "Appearance",
    ]);
  });

  it("Developer is account-scoped and owns programmatic access", () => {
    const developer = SETTINGS_NAV.find((i) => i.key === "developer");
    expect(developer?.scope).toBe("account");
    expect(developer?.description).toContain("tokens");
  });

  it("count strip reflects the live groups", () => {
    expect(settingsCounts()).toBe("6 workspace · 2 account");
  });

  it("group labels carry the name when known", () => {
    expect(groupLabel("workspace", "Floom")).toBe("Workspace · Floom");
    expect(groupLabel("account", "admin@example.com")).toBe("Account · admin@example.com");
    expect(groupLabel("workspace")).toBe("Workspace");
  });

  it("every item has a unique key", () => {
    const keys = SETTINGS_NAV.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every row carries list copy for the Collection", () => {
    expect(SETTINGS_NAV.every((i) => i.description.length > 0)).toBe(true);
  });
});
