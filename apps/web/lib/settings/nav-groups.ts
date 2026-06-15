// Settings nav, grouped per APP-UI-V4-SPEC §4: TWO labeled groups —
//   Workspace · {name}  and  Account · {user}
// with a counts strip like "6 workspace · 2 account".

export type SettingsScope = "workspace" | "account";

export interface SettingsNavItem {
  key:
    | "system"
    | "channels"
    | "assistant"
    | "members"
    | "versions"
    | "workspace_tokens"
    | "danger"
    | "developer"
    | "appearance"
    | "profile";
  label: string;
  scope: SettingsScope;
  description: string;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  // Workspace · {name}
  { key: "system", label: "System", scope: "workspace", description: "Workspace defaults" },
  { key: "channels", label: "Channels", scope: "workspace", description: "Slack, email & WhatsApp" },
  { key: "assistant", label: "Assistant", scope: "workspace", description: "Configure Emily" },
  { key: "members", label: "Members", scope: "workspace", description: "People & roles" },
  { key: "versions", label: "Version history", scope: "workspace", description: "Git-tracked workspace changelog" },
  { key: "workspace_tokens", label: "Workspace token", scope: "workspace", description: "API access to shared workers" },
  { key: "danger", label: "Danger", scope: "workspace", description: "Irreversible actions" },
  // Account · {user}
  { key: "profile", label: "Profile", scope: "account", description: "Display name & avatar" },
  { key: "developer", label: "Developer", scope: "account", description: "Your API, CLI & MCP access" },
  { key: "appearance", label: "Appearance", scope: "account", description: "Theme (light, dark, system)" },
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

export function groupLabel(scope: SettingsScope, name?: string | null): string {
  const base = scope === "workspace" ? "Workspace" : "Account";
  return name ? `${base} · ${name}` : base;
}
