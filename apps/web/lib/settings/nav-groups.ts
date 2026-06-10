// Settings nav, grouped per APP-UI-V4-SPEC §4: TWO labeled groups —
//   Workspace · {name}  and  Account · {user}
// with a counts strip like "4 workspace · 2 account".
//
// This models the LIVE /settings tabs (app/settings/page.tsx renders its
// TabsList from these groups). v4's full target set also moves Assistant,
// Members and Version history under Workspace — today those live on their own
// pages (/assistant, members page, per-asset versions) and migrate in the
// settings regroup pass:
//   TODO(v4-§4): fold Assistant (guarded by #804), Members, Version history
//   (#772 merged timeline) into the Workspace group.

export type SettingsScope = "workspace" | "account";

export interface SettingsNavItem {
  key: string;
  label: string;
  scope: SettingsScope;
  /** Hidden for members in the UI; the server still enforces (e.g. #804). */
  adminOnly?: boolean;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  // Workspace · {name}
  { key: "system", label: "System", scope: "workspace" },
  { key: "git", label: "Git", scope: "workspace" },
  { key: "channels", label: "Channels", scope: "workspace" },
  { key: "danger", label: "Danger", scope: "workspace", adminOnly: true },
  // Account · {user}
  { key: "developer", label: "Developer", scope: "account" },
  { key: "appearance", label: "Appearance", scope: "account" },
];

export function settingsGroup(scope: SettingsScope): SettingsNavItem[] {
  return SETTINGS_NAV.filter((i) => i.scope === scope);
}

/** Count strip, e.g. "4 workspace · 2 account". */
export function settingsCounts(): string {
  const ws = settingsGroup("workspace").length;
  const acct = settingsGroup("account").length;
  return `${ws} workspace · ${acct} account`;
}

export function groupLabel(scope: SettingsScope, name?: string | null): string {
  const base = scope === "workspace" ? "Workspace" : "Account";
  return name ? `${base} · ${name}` : base;
}
