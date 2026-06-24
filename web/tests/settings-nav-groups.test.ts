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
// Workspace vs Account token split:
//   - "Developer" is a WORKSPACE-scoped nav item that renders the shared token
//     plus REST API, MCP, CLI, and Git.
//   - "Personal access tokens" is an ACCOUNT-scoped nav item (yours, fl_pat_).
// They are deliberately in different groups so scope is communicated by WHERE
// each lives.

describe("Settings nav groups (§4)", () => {
  it("Account group: Profile·Personal access tokens", () => {
    expect(settingsGroup("account").map((i) => i.label)).toEqual([
      "Profile",
      "Personal access tokens",
    ]);
  });

  it("Workspace group: General·Members·Channels·Assistant·Developer·Data & lifecycle", () => {
    expect(settingsGroup("workspace").map((i) => i.label)).toEqual([
      "General",
      "Members",
      "Channels",
      "Assistant",
      "Developer",
      "Data & lifecycle",
    ]);
  });

  it("Developer is workspace-scoped, Personal access tokens is account-scoped", () => {
    const developer = SETTINGS_NAV.find((i) => i.key === "developer");
    const acct = SETTINGS_NAV.find((i) => i.key === "personal_tokens");
    expect(developer?.scope).toBe("workspace");
    expect(acct?.scope).toBe("account");
  });

  it("count strip reflects the live groups", () => {
    expect(settingsCounts()).toBe("2 account · 6 workspace");
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
