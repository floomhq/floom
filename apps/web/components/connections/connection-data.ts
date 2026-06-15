import type { ConnectionItem, RunSummary, WorkerDetail } from "@/lib/types";

export type SupportedConnectionApp = {
  slug: string;
  displayName: string;
  icon: string;
};

export type ConnectionRecord = ConnectionItem & {
  account_email?: string;
  auth_config?: { id?: string; scopes?: string[] };
  auth_config_id?: string;
  composio_auth_config_id?: string;
  connected_account?: {
    email?: string;
    user_id?: string;
    auth_config_id?: string;
    scopes?: string[];
  };
  connected_as?: string;
  display_name?: string | null;
  email?: string;
  last_used_at?: string;
  last_used?: string;
  scopes?: string[];
  user_id?: string;
};

export type ConnectionView = ConnectionRecord & {
  accountLabel: string;
  authConfigId?: string;
  displayName: string;
  icon: string;
  lastUsedAt?: string;
  lastCheckedAt?: string;
  lastCheckStatus?: string;
  scopes: string[];
};

export const SUPPORTED_APPS: SupportedConnectionApp[] = [
  { slug: "granola", displayName: "Granola", icon: "granola" },
  { slug: "gmail", displayName: "Gmail", icon: "gmail" },
  { slug: "googlecalendar", displayName: "Google Calendar", icon: "google-calendar" },
  { slug: "googledrive", displayName: "Google Drive", icon: "google-drive" },
  { slug: "slack", displayName: "Slack", icon: "slack" },
  { slug: "notion", displayName: "Notion", icon: "notion" },
  { slug: "linear", displayName: "Linear", icon: "linear" },
  { slug: "github", displayName: "GitHub", icon: "github" },
  { slug: "hubspot", displayName: "HubSpot", icon: "hubspot" },
  { slug: "salesforce", displayName: "Salesforce", icon: "salesforce" },
  // Restored: backend composio_client.py still supports these
  { slug: "linkedin", displayName: "LinkedIn", icon: "linkedin" },
  { slug: "apollo", displayName: "Apollo", icon: "apollo" },
];

const APP_ALIASES: Record<string, string> = {
  "google-calendar": "googlecalendar",
  google_calendar: "googlecalendar",
  calendar: "googlecalendar",
  gcalendar: "googlecalendar",
  "google-drive": "googledrive",
  google_drive: "googledrive",
  drive: "googledrive",
};

const APP_LOOKUP = new Map(SUPPORTED_APPS.map((app) => [app.slug, app]));

export function normalizeAppSlug(slug: string) {
  const normalized = slug.toLowerCase().trim().replace(/\s+/g, "");
  return APP_ALIASES[normalized] ?? normalized;
}

export function getSupportedApp(slug: string) {
  const normalized = normalizeAppSlug(slug);
  return APP_LOOKUP.get(normalized) ?? {
    slug: normalized,
    displayName: titleize(slug),
    icon: normalized,
  };
}

export function formatScope(scope: string) {
  return scope
    .replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
    .replace(/^https:\/\/mail\.google\.com\/$/, "mail.google.com")
    .replace(/^https:\/\/www\..googleapis\.com\/auth\//, "")
    .replace(/_/g, " ")
    .trim();
}

// N6-2: the worker Tools tab used to print the owner's full personal email
// (e.g. firstname.lastname@gmail.com) in plain view. Mask the local part so the
// account is still recognizable (provider + a hint) without leaking the full
// address. Non-email labels (display names, "account …849fe7", status strings)
// are returned unchanged.
export function maskAccountLabel(label: string): string {
  const trimmed = label.trim();
  const at = trimmed.indexOf("@");
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!domain.includes(".")) return trimmed;
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(3)}@${domain}`;
}

export function formatTimestamp(value?: string) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

// PR S12-UI-dry: canonical impl now lives in lib/formatters; re-export here
// for existing import paths so connection cards/workers don't change.
export { formatRelativeTime } from "@/lib/formatters";

export function getConnectionAccountLabel(conn: ConnectionRecord) {
  // E2 fix: prefer display_name (unredacted real email from Composio) over
  // account_label (which may have been redacted server-side). Fall through to
  // legacy fields for backward compat.
  // N10 fix: fall back to connection ID suffix when all human-readable labels
  // are absent or identical (e.g. two Gmail accounts both showing "federico").
  // Appending the suffix ensures the cards are visually distinct.
  const label =
    conn.display_name ||
    conn.account_label ||
    conn.email ||
    conn.account_email ||
    conn.connected_as ||
    conn.connected_account?.email ||
    conn.connected_account?.user_id ||
    conn.user_id;
  if (label) return label;
  // P2-7 (audit 2026-05-29): when no account info is available the row used to
  // show an opaque "account …849fe7" hash. For expired/failed connections the
  // account metadata is genuinely unavailable until reconnect, so say so in
  // plain language instead of showing a meaningless hash.
  const status = (conn.status ?? "").toLowerCase();
  const lastCheck = (conn.last_check_status ?? "").toLowerCase();
  const isBroken =
    status === "expired" ||
    status === "failed" ||
    status === "inactive" ||
    lastCheck === "expired" ||
    lastCheck === "failed";
  if (isBroken) return "Expired; reconnect to see account";
  // Use the last 6 chars of the connection ID as a short disambiguator
  const idSuffix = conn.id ? conn.id.slice(-6) : "";
  return idSuffix ? `account …${idSuffix}` : "unknown account";
}

export function getAuthConfigId(conn: ConnectionRecord) {
  return (
    conn.auth_config?.id ||
    conn.auth_config_id ||
    conn.composio_auth_config_id ||
    conn.connected_account?.auth_config_id
  );
}

export function getConnectionScopes(conn: ConnectionRecord) {
  return (
    asStringArray(conn.scopes) ??
    asStringArray(conn.auth_config?.scopes) ??
    asStringArray(conn.connected_account?.scopes) ??
    []
  );
}

export function toConnectionView(
  conn: ConnectionRecord,
  scopesByConnectionId: Record<string, string[]>,
  metadataByConnectionId: Record<string, Partial<ConnectionRecord>>,
  lastUsedBySlug: Record<string, string | undefined>
): ConnectionView {
  const metadata = metadataByConnectionId[conn.id] ?? {};
  const merged = { ...conn, ...metadata };
  if (merged.kind === "mcp") {
    return {
      ...merged,
      accountLabel: merged.mcp_url || "MCP server",
      authConfigId: undefined,
      displayName: merged.mcp_label || merged.app_name.replace(/^mcp:/, ""),
      icon: "",
      lastUsedAt: merged.last_used_at || merged.last_used,
      lastCheckedAt: conn.last_checked_at ?? undefined,
      lastCheckStatus: conn.last_check_status ?? undefined,
      scopes: merged.mcp_allowed_tools ?? [],
    };
  }

  const app = getSupportedApp(merged.app_name);
  // Use scopes from: (1) hydrated metadata, (2) API-returned scopes, (3) auth_config scopes
  const apiScopes = Array.isArray(conn.scopes) ? conn.scopes : [];
  const scopes =
    scopesByConnectionId[conn.id] ??
    (apiScopes.length > 0 ? apiScopes : getConnectionScopes(merged));
  return {
    ...merged,
    accountLabel: getConnectionAccountLabel(merged),
    authConfigId: getAuthConfigId(merged),
    displayName: app.displayName,
    icon: app.icon,
    lastUsedAt:
      merged.last_used_at ||
      merged.last_used ||
      lastUsedBySlug[normalizeAppSlug(merged.app_name)],
    lastCheckedAt: conn.last_checked_at ?? undefined,
    lastCheckStatus: conn.last_check_status ?? undefined,
    scopes,
  };
}

export async function getLastUsedByConnection(workers: WorkerDetail[]) {
  const lastUsed: Record<string, string | undefined> = {};
  for (const worker of workers) {
    const connections = worker.config?.connections ?? [];
    const latest = getLatestRunTime(worker.recent_runs ?? []);
    if (!latest) continue;
    for (const appName of connections) {
      if (typeof appName !== "string") continue;
      const slug = normalizeAppSlug(appName);
      const current = lastUsed[slug];
      if (!current || new Date(latest).getTime() > new Date(current).getTime()) {
        lastUsed[slug] = latest;
      }
    }
  }
  return lastUsed;
}

function getLatestRunTime(runs: RunSummary[]) {
  return runs
    .map((run) => run.completed_at || run.started_at || run.created_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b as string).getTime() - new Date(a as string).getTime())[0];
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function titleize(value: string) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}
