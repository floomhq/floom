// Settings nav, grouped per APP-UI-V4-SPEC section 4:
//   Workspace · {name} and Account · {user}
// with a counts strip like "6 workspace · 3 account".
//
// Developer owns all programmatic access: personal tokens, workspace token,
// REST API, MCP, CLI, and Git sync. Token scope is called out inside that pane
// instead of creating three top-level rows for one developer workflow.

export type SettingsScope = "workspace" | "account";

export interface SettingsNavItem {
  key:
    | "system"
    | "channels"
    | "assistant"
    | "members"
    | "versions"
    | "danger"
    | "developer"
    | "appearance"
    | "profile";
  label: string;
  scope: SettingsScope;
  description: string;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  // Workspace · {name}: shared/admin controls.
  { key: "system", label: "General", scope: "workspace", description: "Workspace defaults" },
  { key: "members", label: "Members", scope: "workspace", description: "People & roles" },
  { key: "channels", label: "Channels", scope: "workspace", description: "Slack, email & WhatsApp" },
  { key: "assistant", label: "Assistant", scope: "workspace", description: "Configure Emily" },
  { key: "versions", label: "Backups & history", scope: "workspace", description: "Restore points, download a copy, and undo" },
  { key: "danger", label: "Danger zone", scope: "workspace", description: "Irreversible actions" },
  // Account · {user}: per-user controls.
  { key: "profile", label: "Profile", scope: "account", description: "Display name & avatar" },
  { key: "developer", label: "Developer", scope: "account", description: "API, CLI, MCP, Git & tokens" },
  { key: "appearance", label: "Appearance", scope: "account", description: "Theme (light, dark, system)" },
];

export function settingsGroup(scope: SettingsScope): SettingsNavItem[] {
  return SETTINGS_NAV.filter((i) => i.scope === scope);
}

/** Count strip, e.g. "6 workspace · 3 account". */
export function settingsCounts(): string {
  const ws = settingsGroup("workspace").length;
  const acct = settingsGroup("account").length;
  return `${ws} workspace · ${acct} account`;
}

export function groupLabel(scope: SettingsScope, name?: string | null): string {
  const base = scope === "workspace" ? "Workspace" : "Account";
  return name ? `${base} · ${name}` : base;
}
