// Settings nav, grouped per APP-UI-V4-SPEC §4: TWO labeled groups —
//   Account · {user}  and  Workspace · {name}
// with a counts strip like "2 account · 6 workspace".
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
// "Developer" (workspace scope) combines the workspace token with the existing
// developer reference snippets (REST API, MCP install, CLI, Git sync).

export type SettingsScope = "workspace" | "account";

export interface SettingsNavItem {
  key:
    | "system"
    | "channels"
    | "assistant"
    | "members"
    | "developer"
    | "data"
    | "personal_tokens"
    | "profile";
  label: string;
  scope: SettingsScope;
  description: string;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  // Account · {user} — per-user controls.
  { key: "profile", label: "Profile", scope: "account", description: "Display name, avatar & theme" },
  { key: "personal_tokens", label: "Personal access tokens", scope: "account", description: "Yours; work across every workspace" },
  // Workspace · {name} — shared/admin controls.
  { key: "system", label: "General", scope: "workspace", description: "Workspace defaults" },
  { key: "members", label: "Members", scope: "workspace", description: "People & roles" },
  { key: "channels", label: "Channels", scope: "workspace", description: "Slack, email & WhatsApp" },
  { key: "assistant", label: "Assistant", scope: "workspace", description: "Configure Emily" },
  { key: "developer", label: "Developer", scope: "workspace", description: "Workspace token, REST API, MCP, CLI & Git" },
  { key: "data", label: "Data & lifecycle", scope: "workspace", description: "Restore points, download a copy, and irreversible actions" },
];

export function settingsGroup(scope: SettingsScope): SettingsNavItem[] {
  return SETTINGS_NAV.filter((i) => i.scope === scope);
}

/** Count strip, e.g. "2 account · 6 workspace". */
export function settingsCounts(): string {
  const ws = settingsGroup("workspace").length;
  const acct = settingsGroup("account").length;
  return `${acct} account · ${ws} workspace`;
}

export function groupLabel(scope: SettingsScope, name?: string | null): string {
  const base = scope === "workspace" ? "Workspace" : "Account";
  return name ? `${base} · ${name}` : base;
}
