import { describe, it, expect } from "vitest";
import {
  SETTINGS_NAV,
  settingsGroup,
  settingsCounts,
  groupLabel,
} from "@/lib/settings/nav-groups";

// §4 two-group settings nav — this model is what app/settings/page.tsx renders
// its left rail / Collection from, so these assertions guard the live strip.
//
// Workspace vs Account token split (mockup settings-mockup/index.html):
//   - "Workspace token" is a WORKSPACE-scoped nav item (shared fl_wt_ token).
//   - "Personal access tokens" is an ACCOUNT-scoped nav item (yours, fl_pat_).
// They are deliberately in different groups so scope is communicated by WHERE
// each lives. The old consolidated "Developer" item is gone; its API/MCP/CLI/Git
// reference now lives under "Connect & automate".

describe("Settings nav groups (§4)", () => {
  it("Workspace group: General·Members·Channels·Assistant·Workspace token·Backups & history·Danger zone", () => {
    expect(settingsGroup("workspace").map((i) => i.label)).toEqual([
      "General",
      "Members",
      "Channels",
      "Assistant",
      "Workspace token",
      "Backups & history",
      "Danger zone",
    ]);
  });

  it("Account group: Profile·Personal access tokens·Connect & automate·Appearance", () => {
    expect(settingsGroup("account").map((i) => i.label)).toEqual([
      "Profile",
      "Personal access tokens",
      "Connect & automate",
      "Appearance",
    ]);
  });

  it("Workspace token is workspace-scoped, Personal access tokens is account-scoped", () => {
    const ws = SETTINGS_NAV.find((i) => i.key === "workspace_token");
    const acct = SETTINGS_NAV.find((i) => i.key === "personal_tokens");
    expect(ws?.scope).toBe("workspace");
    expect(acct?.scope).toBe("account");
  });

  it("count strip reflects the live groups", () => {
    expect(settingsCounts()).toBe("7 workspace · 4 account");
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
