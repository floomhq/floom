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
  it("Workspace group is System·Git·Channels·Danger", () => {
    expect(settingsGroup("workspace").map((i) => i.label)).toEqual([
      "System",
      "Git",
      "Channels",
      "Danger",
    ]);
  });

  it("Account group is Developer·Appearance", () => {
    expect(settingsGroup("account").map((i) => i.label)).toEqual(["Developer", "Appearance"]);
  });

  it("count strip reflects the live groups", () => {
    expect(settingsCounts()).toBe("4 workspace · 2 account");
  });

  it("group labels carry the name when known", () => {
    expect(groupLabel("workspace", "Floom")).toBe("Workspace · Floom");
    expect(groupLabel("account", "vivek@floom.dev")).toBe("Account · vivek@floom.dev");
    expect(groupLabel("workspace")).toBe("Workspace");
  });

  it("every item has a unique key", () => {
    const keys = SETTINGS_NAV.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("Danger is the only UI-hidden admin item (server enforces the rest)", () => {
    expect(SETTINGS_NAV.filter((i) => i.adminOnly).map((i) => i.key)).toEqual(["danger"]);
  });
});
