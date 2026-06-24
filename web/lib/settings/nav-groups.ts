// Settings nav, grouped per APP-UI-V4-SPEC §4: TWO labeled groups —
//   Workspace · {name}  and  Account · {user}
// with a counts strip like "7 workspace · 4 account".
//
// Scope is communicated by WHERE a thing lives (the group it sits in) plus a
// scope chip in each detail pane. This is the core of the token-confusion fix
// (mockup: settings-mockup/index.html):
//   - "Workspace token" lives under WORKSPACE  — one shared token (fl_wt_…)
//     for this workspace's CLI & CI. Rotating it affects everyone.
//   - "Personal access tokens" live under ACCOUNT — yours (fl_pat_…), they
//     follow you across every workspace and act on your behalf.
// Each token pane carries a scope chip + a cross-link to the other so the
// "is this mine or the workspace's?" question is answered in-place.
//
// "Connect & automate" (account scope) holds the developer reference snippets
// (REST API, MCP install, CLI, Git sync) — no token CRUD, those moved to the
// two token panes above.

export type SettingsScope = "workspace" | "account";

export interface SettingsNavItem {
  key:
    | "system"
    | "channels"
    | "assistant"
    | "members"
    | "workspace_token"
    | "versions"
    | "danger"
    | "personal_tokens"
    | "connect"
    | "appearance"
    | "profile";
  label: string;
  scope: SettingsScope;
  description: string;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  // Workspace · {name} — shared/admin controls.
  { key: "system", label: "General", scope: "workspace", description: "Workspace defaults" },
  { key: "members", label: "Members", scope: "workspace", description: "People & roles" },
  { key: "channels", label: "Channels", scope: "workspace", description: "Slack, email & WhatsApp" },
  { key: "assistant", label: "Assistant", scope: "workspace", description: "Configure Emily" },
  { key: "workspace_token", label: "Workspace token", scope: "workspace", description: "Shared token for this workspace's CLI & CI" },
  { key: "versions", label: "Backups & history", scope: "workspace", description: "Restore points, download a copy, and undo" },
  { key: "danger", label: "Danger zone", scope: "workspace", description: "Irreversible actions" },
  // Account · {user} — per-user controls.
  { key: "profile", label: "Profile", scope: "account", description: "Display name & avatar" },
  { key: "personal_tokens", label: "Personal access tokens", scope: "account", description: "Yours; work across every workspace" },
  { key: "connect", label: "Connect & automate", scope: "account", description: "REST API, MCP, CLI & Git" },
  { key: "appearance", label: "Appearance", scope: "account", description: "Theme (light, dark, system)" },
];

export function settingsGroup(scope: SettingsScope): SettingsNavItem[] {
  return SETTINGS_NAV.filter((i) => i.scope === scope);
}

/** Count strip, e.g. "7 workspace · 4 account". */
export function settingsCounts(): string {
  const ws = settingsGroup("workspace").length;
  const acct = settingsGroup("account").length;
  return `${ws} workspace · ${acct} account`;
}

export function groupLabel(scope: SettingsScope, name?: string | null): string {
  const base = scope === "workspace" ? "Workspace" : "Account";
  return name ? `${base} · ${name}` : base;
}
