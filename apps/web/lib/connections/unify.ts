/**
 * Connections = ONE list; Type is a tag (SPEC §1a). This module is the pure
 * transform that merges the connections endpoint (Composio + MCP via `kind`)
 * and the separate secrets endpoint into one uniform item shape, so the
 * Collection treats Connection / MCP / Secret as type-filtered rows of one list.
 */
import type { ConnectionItem, ConnectionStatus, SecretItem } from "@/lib/types";
import type { PillTone } from "@/lib/collection/types";

export type ConnKind = "connection" | "mcp" | "secret";
export type ConnStatusKey = "active" | "reauth" | "error";

export interface UnifiedConn {
  id: string;
  kind: ConnKind;
  name: string;
  account: string;
  statusKey: ConnStatusKey;
  detail: string;
  connection?: ConnectionItem;
  secret?: SecretItem;
}

export const TYPE_LABEL: Record<ConnKind, string> = {
  connection: "Connection",
  mcp: "MCP",
  secret: "Secret",
};

export const STATUS_PILL: Record<ConnStatusKey, { tone: PillTone; label: string }> = {
  active: { tone: "ok", label: "Active" },
  reauth: { tone: "warn", label: "Reauth" },
  error: { tone: "err", label: "Error" },
};

/** Map the raw connection status to the SPEC's Active / Reauth / Error. */
export function connStatusKey(s: ConnectionStatus): ConnStatusKey {
  if (s === "active") return "active";
  if (s === "expired" || s === "initiated") return "reauth";
  return "error"; // failed | unknown | not_found
}

const APP_NAME_OVERRIDES: Record<string, string> = {
  github: "GitHub",
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  googlesheets: "Google Sheets",
  slack: "Slack",
};

/** Capitalise the first letter and replace underscores/hyphens with spaces. */
export function humaniseAppName(s: string): string {
  if (!s) return s;
  const key = s.toLowerCase().replace(/[_\-\s]+/g, "");
  if (APP_NAME_OVERRIDES[key]) return APP_NAME_OVERRIDES[key];
  return s
    .replace(/[_-]+/g, " ")
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

export function toUnified(connections: ConnectionItem[], secrets: SecretItem[]): UnifiedConn[] {
  const fromConns: UnifiedConn[] = connections.map((c) => {
    const isMcp = c.kind === "mcp";
    // Primary = APP NAME (human-readable service, e.g. "Gmail", "Google Sheets")
    // NOT display_name/account_label which is often just the user's account slug.
    const appName = c.mcp_label || humaniseAppName(c.app_name || "");
    return {
      id: c.id,
      kind: isMcp ? "mcp" : "connection",
      name: isMcp ? appName : appName,
      account: isMcp
        ? c.mcp_url || c.mcp_command || "MCP server"
        : c.account_label || c.display_name || c.app_name,
      statusKey: connStatusKey(c.status),
      detail: isMcp
        ? `${c.mcp_allowed_tools?.length ?? 0} tools`
        : `${c.scopes?.length ?? 0} scopes`,
      connection: c,
    };
  });
  const fromSecrets: UnifiedConn[] = secrets.map((s) => ({
    id: `secret:${s.name}`,
    kind: "secret",
    name: s.name,
    account: "••••••••",
    statusKey: s.status === "set" ? "active" : "error",
    detail: `used by ${s.used_by?.length ?? 0}`,
    secret: s,
  }));
  return [...fromConns, ...fromSecrets];
}
