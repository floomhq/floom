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

export function formatTimestamp(value?: string) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatRelativeTime(value?: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 2) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export function getConnectionAccountLabel(conn: ConnectionRecord) {
  return (
    conn.account_label ||
    conn.email ||
    conn.account_email ||
    conn.connected_as ||
    conn.connected_account?.email ||
    conn.connected_account?.user_id ||
    conn.user_id ||
    "unknown account"
  );
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
