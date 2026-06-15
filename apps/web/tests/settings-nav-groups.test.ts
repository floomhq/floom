import { describe, it, expect } from "vitest";
import {
  SETTINGS_NAV,
  settingsGroup,
  settingsCounts,
  groupLabel,
} from "@/lib/settings/nav-groups";

// §4 two-group settings nav — this model is what app/settings/page.tsx renders
// its TabsList from, so these assertions guard the live strip.

describe("Settings nav groups (§4)", () => {
  it("Workspace group is System·Channels·Assistant·Members·Version history·Workspace token·Danger", () => {
    expect(settingsGroup("workspace").map((i) => i.label)).toEqual([
      "System",
      "Channels",
      "Assistant",
      "Members",
      "Version history",
      "Workspace token",
      "Danger",
    ]);
  });

  it("Account group is Profile·Developer·Appearance", () => {
    expect(settingsGroup("account").map((i) => i.label)).toEqual(["Profile", "Developer", "Appearance"]);
  });

  it("count strip reflects the live groups", () => {
    expect(settingsCounts()).toBe("7 workspace · 3 account");
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
