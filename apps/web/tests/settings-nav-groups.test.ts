import { describe, it, expect } from "vitest";
import {
  SETTINGS_NAV,
  settingsGroup,
  settingsCounts,
  groupLabel,
} from "@/lib/settings/nav-groups";

describe("Settings nav groups (§4)", () => {
  it("Workspace group is System·Channels·Assistant·Members·Version history·Danger", () => {
    expect(settingsGroup("workspace").map((i) => i.label)).toEqual([
      "System",
      "Channels",
      "Assistant",
      "Members",
      "Version history",
      "Danger",
    ]);
  });

  it("Account group is Developer·Appearance", () => {
    expect(settingsGroup("account").map((i) => i.label)).toEqual(["Developer", "Appearance"]);
  });

  it("count strip is '6 workspace · 2 account'", () => {
    expect(settingsCounts()).toBe("6 workspace · 2 account");
  });

  it("group labels carry the name", () => {
    expect(groupLabel("workspace", "Floom")).toBe("Workspace · Floom");
    expect(groupLabel("account", "vivek@floom.dev")).toBe("Account · vivek@floom.dev");
  });

  it("every item has a unique key", () => {
    const keys = SETTINGS_NAV.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("admin-only items are server-gated (system/assistant/members/danger)", () => {
    const admin = SETTINGS_NAV.filter((i) => i.adminOnly).map((i) => i.key).sort();
    expect(admin).toEqual(["assistant", "danger", "members", "system"]);
  });
});
