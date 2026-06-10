// Settings nav, grouped per APP-UI-V4-SPEC §4:
//   Workspace · {name}  — System · Channels · Assistant · Members · Version history · Danger
//   Account · {user}    — Developer · Appearance
// Counts render as e.g. "6 workspace · 2 account". Model + test lock the contract
// so the settings page can render the two labeled groups from one source.

export type SettingsScope = "workspace" | "account";

export interface SettingsNavItem {
  key: string;
  label: string;
  scope: SettingsScope;
  /** Admin-only items (server still enforces — e.g. #804). */
  adminOnly?: boolean;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  // Workspace · {name}
  { key: "system", label: "System", scope: "workspace", adminOnly: true },
  { key: "channels", label: "Channels", scope: "workspace" },
  { key: "assistant", label: "Assistant", scope: "workspace", adminOnly: true },
  { key: "members", label: "Members", scope: "workspace", adminOnly: true },
  { key: "version-history", label: "Version history", scope: "workspace" },
  { key: "danger", label: "Danger", scope: "workspace", adminOnly: true },
  // Account · {user}
  { key: "developer", label: "Developer", scope: "account" },
  { key: "appearance", label: "Appearance", scope: "account" },
];

export function settingsGroup(scope: SettingsScope): SettingsNavItem[] {
  return SETTINGS_NAV.filter((i) => i.scope === scope);
}

/** Count strip, e.g. "6 workspace · 2 account". */
export function settingsCounts(): string {
  const ws = settingsGroup("workspace").length;
  const acct = settingsGroup("account").length;
  return `${ws} workspace · ${acct} account`;
}

export function groupLabel(scope: SettingsScope, name: string): string {
  return scope === "workspace" ? `Workspace · ${name}` : `Account · ${name}`;
}
