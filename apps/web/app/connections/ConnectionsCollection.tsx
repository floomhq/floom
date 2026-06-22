"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, Copy, Eye, EyeOff, Mail, Server, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useConnections, useMembers, useSecrets, useWorkers } from "@/lib/query/hooks";
import type { ConnectionItem, RunSummary, SecretItem, WorkerSummary, WorkspaceMember } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { LoadingState } from "@/components/collection/CollectionStates";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { RunStatusBadge } from "@/components/RunStatus";
import { StatusPill } from "@/components/collection/StatusPill";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type UnifiedConn,
  STATUS_PILL,
  TYPE_LABEL,
  toUnified,
  humaniseAppName,
} from "@/lib/connections/unify";
import { resolveUserLabel } from "@/lib/workspace/display-name";

// ---------------------------------------------------------------------------
// #1233: Resolve owner_id to display name / email.
// Works client-side from the workspace members list fetched on load.
// If backend later populates owner_display_name on ConnectionItem, prefer that.
// ---------------------------------------------------------------------------
export function resolveOwner(
  ownerId: string | null | undefined,
  members: WorkspaceMember[],
): string {
  if (!ownerId) return "Not set";
  const member = members.find((m) => m.user_id === ownerId);
  // #1728: never surface a raw UUID/ws_ owner id. When the id cannot be
  // resolved to a real member label, fall back to the friendly workspace label.
  return resolveUserLabel(
    [member?.display_name, member?.email],
    "My workspace",
  );
}

function Logo({ item }: { item: UnifiedConn }) {
  if (item.kind === "connection" && item.connection) {
    return (
      <span className="c-logo">
        <BrandLogo icon={item.connection.app_name} />
      </span>
    );
  }
  return (
    <span className="c-logo">
      {item.kind === "mcp" ? <Server size={16} /> : <KeyRound size={16} />}
    </span>
  );
}

function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "9px 16px" }}>
      {rows.map(([k, v], i) => (
        <span key={i} style={{ display: "contents" }}>
          <span style={{ color: "var(--muted-foreground)", fontSize: 12.5 }}>{k}</span>
          <span>{v}</span>
        </span>
      ))}
    </div>
  );
}

/** Icon-only copy button: shows a checkmark for 1.5s after copying. */
function CopyIconButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => toast.error("Copy failed"),
    );
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={label ?? "Copy"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        borderRadius: "var(--radius-pill)",
        border: "var(--bd-pill)",
        background: "var(--bg-2)",
        color: "var(--muted-foreground)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {copied
        ? <Check style={{ width: 11, height: 11, color: "var(--positive)" }} />
        : <Copy style={{ width: 11, height: 11 }} />}
    </button>
  );
}

/**
 * Masked secret value field: dots + eye toggle + copy affordance.
 * Reveal calls the backend name-only test endpoint to surface the masked
 * value from env; if no reveal endpoint exists, shows dots with copy only.
 * Per v4 spec: monospace, reveal button, copy button inline.
 */
function SecretValueField({ name }: { name: string }) {
  const [revealed, setRevealed] = useState(false);
  const MASKED = "••••••••••••";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
      <span style={{ letterSpacing: revealed ? undefined : "0.08em" }}>{MASKED}</span>
      <button
        type="button"
        onClick={() => setRevealed((v: boolean) => !v)}
        title={revealed ? "Hide" : "Reveal: values are write-only and not returned by the API"}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          borderRadius: "var(--radius-pill)",
          border: "var(--bd-pill)",
          background: "var(--bg-2)",
          color: "var(--muted-foreground)",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        {revealed
          ? <EyeOff style={{ width: 11, height: 11 }} />
          : <Eye style={{ width: 11, height: 11 }} />}
      </button>
      <CopyIconButton value={name} label="Copy secret name" />
    </span>
  );
}

function formatLastUsed(connection: ConnectionItem) {
  if (!connection.last_used_at) return "Never";
  const date = new Date(connection.last_used_at);
  const when = Number.isNaN(date.getTime())
    ? connection.last_used_at
    : date.toLocaleDateString();
  return connection.last_used_by ? `${when} · ${connection.last_used_by}` : when;
}

function EmailPeekPanel({ connectionId }: { connectionId: string }) {
  const [emailPeek, setEmailPeek] = useState<
    Array<{ subject: string; from_name: string; from_email: string; date: string }>
  >([]);
  const [loadingPeek, setLoadingPeek] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoadingPeek(true);
    api.connections
      .peek(connectionId)
      .then((result) => {
        if (alive) setEmailPeek(result.emails ?? []);
      })
      .catch(() => {
        if (alive) setEmailPeek([]);
      })
      .finally(() => {
        if (alive) setLoadingPeek(false);
      });
    return () => {
      alive = false;
    };
  }, [connectionId]);

  if (loadingPeek) return <LoadingState rows={3} />;

  return (
    <div className="c-ltable">
      <div className="c-lrow" style={{ gridTemplateColumns: "auto 1fr", alignItems: "start" }}>
        <Mail className="mt-1 size-4 text-muted-foreground" />
        <div className="c-lprimary">
          <div className="c-lp-tx">
            <div className="nm">Recent emails</div>
            <div className="meta">Trust signal from the connected Gmail account.</div>
          </div>
        </div>
      </div>
      {emailPeek.map((email, index) => (
        <div
          key={`${email.from_email}-${email.date}-${index}`}
          className="c-lrow"
          style={{ gridTemplateColumns: "1fr auto" }}
        >
          <div className="c-lprimary">
            <div className="c-lp-tx">
              <div className="nm">{email.subject || "(No subject)"}</div>
              <div className="meta">
                {email.from_name || email.from_email}
                {email.from_name && email.from_email ? ` <${email.from_email}>` : ""}
              </div>
            </div>
          </div>
          <span className="c-cell m">{email.date ? new Date(email.date).toLocaleDateString() : ""}</span>
        </div>
      ))}
      {emailPeek.length === 0 && <div style={pad}>No recent emails available.</div>}
    </div>
  );
}

function ActivityPanel({ connectionId }: { connectionId: string }) {
  const [activity, setActivity] = useState<RunSummary[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoadingActivity(true);
    api.connections
      .activity(connectionId)
      .then((runs) => {
        if (alive) setActivity(runs ?? []);
      })
      .catch(() => {
        if (alive) setActivity([]);
      })
      .finally(() => {
        if (alive) setLoadingActivity(false);
      });
    return () => {
      alive = false;
    };
  }, [connectionId]);

  if (loadingActivity) return <LoadingState rows={3} />;

  return (
    <div className="c-ltable">
      {activity.map((run) => (
        <Link
          key={run.id}
          href={`/runs?sel=${encodeURIComponent(run.id)}`}
          className="c-lrow"
          style={{ gridTemplateColumns: "1fr auto", textDecoration: "none" }}
        >
          <div className="c-lprimary">
            <div className="c-lp-tx">
              <div className="nm">{run.worker_name || run.worker_id}</div>
              <div className="meta">{run.created_at ? new Date(run.created_at).toLocaleString() : run.id}</div>
            </div>
          </div>
          <RunStatusBadge status={run.status} showSuccess />
        </Link>
      ))}
      {activity.length === 0 && <div style={pad}>No recent activity.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tools tab — the SCOPED-TOOLS surface for a connection.
//   * MCP   : the live tools advertised by the server (GET /connections/{id}/tools,
//             reused via api.connections.tools) split into "Allowed for workers"
//             (the configured mcp_allowed_tools) and "Available but not allowed"
//             (live − configured). Degrades to the configured allowlist on 503.
//   * OAuth : the curated read-only preset (GET /connections/tool-presets?app=)
//             vs the full granted scope. Copy is honest: this is the DEFAULT
//             scope for new workers — the real allowlist is per-worker
//             (WorkerConnectionSpec.allowed_tools), so each worker can narrow it.
// ---------------------------------------------------------------------------
function ToolChips({ items, mono = true }: { items: string[]; mono?: boolean }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {items.map((t) => (
        <span
          key={t}
          className="c-vpill"
          style={{ fontFamily: mono ? "var(--font-mono)" : undefined, fontSize: 11.5 }}
        >
          {t}
        </span>
      ))}
    </div>
  );
}

function ToolSection({ label, items, mono }: { label: string; items: string[]; mono?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--muted-foreground)" }}>
        {label} · {items.length}
      </div>
      {items.length > 0 ? <ToolChips items={items} mono={mono} /> : <div style={pad}>None.</div>}
    </div>
  );
}

function McpToolsPanel({ connection }: { connection: ConnectionItem }) {
  const allowed = connection.mcp_allowed_tools ?? [];
  const [live, setLive] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setUnreachable(false);
    api.connections
      .tools(connection.id)
      .then((r) => {
        if (alive) setLive(r.tools ?? []);
      })
      .catch(() => {
        if (alive) setUnreachable(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [connection.id]);

  if (loading) return <LoadingState rows={3} />;

  // "Available but not allowed" = live server tools the allowlist doesn't include.
  const allowedSet = new Set(allowed);
  const available = (live ?? []).filter((t) => !allowedSet.has(t));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ToolSection label="Allowed for workers" items={allowed} />
      {unreachable ? (
        <div style={pad}>
          Server unreachable: showing the configured allowlist only. Test the
          connection to enumerate live tools.
        </div>
      ) : (
        <ToolSection label="Available but not allowed · live from server" items={available} />
      )}
    </div>
  );
}

const TOOL_PRESET_SCOPES = ["Read-only", "All", "Custom"] as const;
type ToolPresetScope = (typeof TOOL_PRESET_SCOPES)[number];

function OAuthToolsPanel({ connection }: { connection: ConnectionItem }) {
  const scopes = connection.scopes ?? [];
  const [preset, setPreset] = useState<string[] | null>(null);
  const [scope, setScope] = useState<ToolPresetScope>("Read-only");

  useEffect(() => {
    let alive = true;
    api.connections
      .toolPresets(connection.app_name)
      .then((r) => {
        if (alive) setPreset(r.tools ?? null);
      })
      .catch(() => {
        if (alive) setPreset(null);
      });
    return () => {
      alive = false;
    };
  }, [connection.app_name]);

  const readOnly = preset ?? [];
  const shown =
    scope === "Read-only" ? readOnly : scope === "All" ? scopes : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "inline-flex", gap: 2, alignSelf: "flex-start", background: "var(--bg-2)", padding: 3, borderRadius: "var(--radius-pill)" }}>
        {TOOL_PRESET_SCOPES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(s)}
            className={scope === s ? "c-addbtn" : "c-vpill"}
            style={{ padding: "4px 12px", fontSize: 12, border: "none" }}
          >
            {s === "All" ? `All ${scopes.length}` : s}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
        Default tool scope for new workers. Each worker can narrow this further.
      </div>
      {scope === "Custom" ? (
        <div style={pad}>Configure the exact tool list on each worker (Setup → Tools).</div>
      ) : (
        <ToolSection label="Granted scopes" items={shown} mono={false} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secrets tab — secrets associated with this connection, grouped by NAME prefix
// convention (the backend has no connection_id FK — pure UI grouping). The
// managed OAuth token (when present) is shown as a read-only "managed" row that
// rotates on reconnect; user-set secrets get Test / Replace / Delete inline.
// "Replace" is the honest label: there is no rotate endpoint, rotation = setting
// a new value over the old one (POST /secrets/{name}). Set/test/delete are the
// real api.secrets.{upsert,test,delete} calls.
// ---------------------------------------------------------------------------
function secretsForConnection(connection: ConnectionItem, secrets: SecretItem[]): SecretItem[] {
  const prefix = (connection.app_name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!prefix) return [];
  return secrets.filter((s) => s.name.toUpperCase().startsWith(prefix));
}

function ConnSecretsPanel({
  connection,
  secrets,
  onChanged,
}: {
  connection: ConnectionItem;
  secrets: SecretItem[];
  onChanged: () => void;
}) {
  const related = secretsForConnection(connection, secrets);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false);

  const isManaged = (name: string) => /TOKEN|OAUTH/.test(name.toUpperCase());

  const test = async (name: string) => {
    try {
      const r = await api.secrets.test(name);
      toast[r.status === "set" || r.status === "valid" ? "success" : "error"](`${name}: ${r.status}`);
    } catch {
      toast.error(`Test failed for ${name}`);
    }
  };
  const replace = async (name: string) => {
    const value = window.prompt(`New value for ${name} (write-only, overwrites the old value):`);
    if (value == null || value === "") return;
    try {
      await api.secrets.upsert(name, value);
      toast.success(`${name} replaced`);
      onChanged();
    } catch {
      toast.error(`Could not replace ${name}`);
    }
  };
  const del = async (name: string) => {
    try {
      await api.secrets.delete(name);
      toast.success(`Deleted ${name}`);
      onChanged();
    } catch {
      toast.error(`Could not delete ${name}`);
    }
  };
  const add = async () => {
    if (!newName.trim() || !newValue) return;
    setBusy(true);
    try {
      await api.secrets.upsert(newName.trim(), newValue);
      toast.success(`Saved ${newName.trim()}`);
      setNewName("");
      setNewValue("");
      setAdding(false);
      onChanged();
    } catch {
      toast.error(`Could not save ${newName.trim()}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="c-ltable">
        {related.map((s) => {
          const managed = isManaged(s.name);
          return (
            <div key={s.name} className="c-lrow" style={{ gridTemplateColumns: "1fr auto", alignItems: "center" }}>
              <div className="c-lprimary">
                <div className="c-lp-tx">
                  <div className="nm" style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{s.name}</div>
                  <div className="meta">
                    {managed
                      ? "Managed · rotates on reconnect"
                      : `Reference as secret:${s.name}`}
                  </div>
                </div>
              </div>
              {managed ? (
                <StatusPill spec={{ tone: "ok", label: "Set" }} />
              ) : (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <button type="button" className="c-vpill" style={pillBtn} onClick={() => void test(s.name)}>Test</button>
                  <button type="button" className="c-vpill" style={pillBtn} onClick={() => void replace(s.name)}>Replace</button>
                  <button type="button" className="c-vpill" style={pillBtn} onClick={() => void del(s.name)}>Delete</button>
                </span>
              )}
            </div>
          );
        })}
        {related.length === 0 && <div style={pad}>No secrets stored for this connection.</div>}
      </div>
      {adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 460 }}>
          <input
            placeholder={`${(connection.app_name || "APP").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }}
          />
          <input
            type="password"
            placeholder="Value (write-only, never returned)"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            style={fieldStyle}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="c-addbtn" style={pillBtn} disabled={busy} onClick={() => void add()}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" className="c-vpill" style={pillBtn} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className="c-vpill" style={{ ...pillBtn, alignSelf: "flex-start" }} onClick={() => setAdding(true)}>
          + Add secret
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Used by — the reverse index of workers that declare this connection. Derived
// client-side from the worker list (WorkerSummary.connections = app slugs) since
// there is no single dedicated endpoint. Powers the disconnect-impact warning.
// ---------------------------------------------------------------------------
function workersUsing(connection: ConnectionItem, workers: WorkerSummary[]): WorkerSummary[] {
  const slug = (connection.app_name || "").toLowerCase();
  if (!slug) return [];
  return workers.filter((w) => (w.connections ?? []).some((c) => c.toLowerCase() === slug));
}

function UsedByPanel({ connection, workers }: { connection: ConnectionItem; workers: WorkerSummary[] }) {
  const using = workersUsing(connection, workers);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {using.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          Disconnecting stops {using.length} worker{using.length !== 1 ? "s" : ""} that depend on this connection.
        </div>
      )}
      <div className="c-ltable">
        {using.map((w) => (
          <Link
            key={w.id}
            href={`/workers/${encodeURIComponent(w.id)}`}
            className="c-lrow"
            style={{ gridTemplateColumns: "1fr", textDecoration: "none" }}
          >
            <div className="c-lprimary">
              <div className="c-lp-tx">
                <div className="nm">{w.name}</div>
              </div>
            </div>
          </Link>
        ))}
        {using.length === 0 && <div style={pad}>No workers use this connection yet.</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advanced ▾ group for the connection detail — mirrors the worker-detail
// pattern: a clearly-visible affordance ON the primary tab row (tabsTrailing,
// right-aligned) that pins + opens secondary tabs (per-mode: Recent emails for
// Gmail, Config for MCP). Reuses the real DropdownMenu primitives + .c-dtab-adv.
// ---------------------------------------------------------------------------
function ConnAdvancedMenu({
  advancedTabs,
  pinned,
  onToggle,
}: {
  advancedTabs: string[];
  pinned: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  if (advancedTabs.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="c-dtab-adv inline-flex items-center gap-1"
        aria-label="Advanced tabs"
        title="Open advanced connection tabs"
      >
        Advanced
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 p-1">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Advanced tabs</DropdownMenuLabel>
          {advancedTabs.map((key) => (
            <DropdownMenuCheckboxItem
              key={key}
              checked={pinned.has(key)}
              closeOnClick={false}
              onCheckedChange={(checked) => onToggle(key, checked)}
            >
              {key}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function ConnectionsCollection({
  initialConnections,
}: {
  initialConnections: ConnectionItem[];
}) {
  const connectionsQuery = useConnections(initialConnections);
  const secretsQuery = useSecrets();
  const workersQuery = useWorkers();
  const membersQuery = useMembers();
  const connections = connectionsQuery.data ?? initialConnections;
  const secrets = secretsQuery.data ?? [];
  const workers = workersQuery.data ?? [];
  const members = membersQuery.data ?? [];
  const hasCachedData = connections.length > 0 || secrets.length > 0 || workers.length > 0 || members.length > 0;
  const firstLoadPending =
    (connectionsQuery.isLoading && !connectionsQuery.data) ||
    (secretsQuery.isLoading && !secretsQuery.data) ||
    (workersQuery.isLoading && !workersQuery.data) ||
    (membersQuery.isLoading && !membersQuery.data);
  // #1269/#1279: keep the hung-API safety timeout, now applied to the query
  // first-load state. Cached revisits bypass it and render immediately.
  const [timedOut, setTimedOut] = useState(false);
  const loading = firstLoadPending && !timedOut;
  const error =
    timedOut && !hasCachedData
      ? "Could not load connections. Check your connection and try again."
      : connectionsQuery.isError && !connectionsQuery.data
        ? "Could not load connections. Check your connection and try again."
        : null;
  // Pinned advanced connection tabs (per-session): the "Advanced ▾" group on the
  // tab row pins/opens secondary tabs (Recent emails, Config). Mirrors the
  // worker-detail Advanced group but session-scoped (no cross-worker preference
  // to persist for connections).
  const [pinnedTabs, setPinnedTabs] = useState<Set<string>>(new Set());
  const toggleAdvancedTab = (key: string) =>
    setPinnedTabs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const refresh = async () => {
    await Promise.allSettled([
      connectionsQuery.refetch(),
      secretsQuery.refetch(),
      workersQuery.refetch(),
      membersQuery.refetch(),
    ]);
  };

  useEffect(() => {
    if (!firstLoadPending) return;
    const timeout = setTimeout(() => {
      setTimedOut(true);
    }, 25_000);
    return () => clearTimeout(timeout);
  }, [firstLoadPending]);

  const items = useMemo(() => toUnified(connections, secrets), [connections, secrets]);

  // #1226: name -> worker id map for clickable used-by links
  const workersByName = useMemo(
    () => new Map(workers.map((w) => [w.name, w.id])),
    [workers],
  );

  const remove = async (item: UnifiedConn) => {
    try {
      if (item.kind === "secret" && item.secret) await api.secrets.delete(item.secret.name);
      else await api.connections.delete(item.id);
      toast.success(`Removed ${item.name}`);
      await refresh();
    } catch {
      toast.error(`Could not remove ${item.name}`);
    }
  };

  const test = async (item: UnifiedConn) => {
    try {
      if (item.kind === "secret" && item.secret) {
        const r = await api.secrets.test(item.secret.name);
        toast[r.status === "set" || r.status === "valid" ? "success" : "error"](
          `${item.name}: ${r.status}`,
        );
      } else {
        const r = await api.connections.test(item.id);
        toast[r.status === "valid" ? "success" : "error"](`${item.name}: ${r.status}`);
      }
    } catch {
      toast.error(`Test failed for ${item.name}`);
    }
  };

  const config: CollectionConfig<UnifiedConn> = {
    title: "Connections",
    subtitle: "Apps, MCP servers and secrets your workers can use.",
    items,
    loading,
    error,
    idOf: (i) => i.id,
    searchOf: (i) => `${i.name} ${i.account} ${TYPE_LABEL[i.kind]}`,
    // IA (Federico 2026-06-19): Connected / MCP / Secrets are TYPE filters on the
    // one unified list, surfaced through the STANDARD `filters` affordance the
    // Workers/Runs collections use (the TagBar's collapsible filter button), not a
    // bespoke top chip-row. "Browse apps" is no longer a section — it is the Add
    // button (the add-app action), so it is dropped from this filter set. Status
    // (active / reauth / error) stays as a second family for credential health.
    tagsOf: (i) =>
      ({ type: [i.kind], status: [i.statusKey] }) as Partial<
        Record<TagFamilyKey, string[]>
      >,
    tags: {
      type: [
        { value: "connection", label: "Connected" },
        { value: "mcp", label: "MCP" },
        { value: "secret", label: "Secrets" },
      ],
      status: [
        { value: "active", label: "active" },
        { value: "reauth", label: "reauth" },
        { value: "error", label: "error" },
      ],
    },
    view: { default: "list", grid: true },
    columns: {
      template: "1.8fr 110px 1fr 120px 40px",
      headers: ["Connects to", "Type", "Detail", "Status", ""],
      headerTransparent: true,
    },
    row: (i) => ({
      leading: <Logo item={i} />,
      primary: i.name,
      secondary: i.account,
      cols: [
        <span key="t" className="c-vpill">
          {TYPE_LABEL[i.kind]}
        </span>,
        i.detail,
      ],
      status: STATUS_PILL[i.statusKey],
      menu: [
        { label: "Test", onSelect: () => void test(i) },
        { label: "Remove", onSelect: () => void remove(i), danger: true },
      ],
    }),
    card: (i) => ({
      leading: <Logo item={i} />,
      name: i.name,
      description: i.account,
      status: STATUS_PILL[i.statusKey],
    }),
    detail: (i) => {
      // The two highest-value actions inline (Test + Reconnect for managed
      // connections), with disconnect demoted into a More ▾ menu so the
      // destructive action is never a primary button (matches worker/run detail).
      const actions = (
        <>
          {i.kind === "connection" && i.connection && (
            <Link
              href={`/connections/connect/${encodeURIComponent(i.connection.app_name)}?return_to=${encodeURIComponent("/connections")}`}
              className="c-addbtn"
              style={pillBtn}
            >
              Reconnect
            </Link>
          )}
          <button type="button" className="c-addbtn" style={pillBtn} onClick={() => void test(i)}>
            Test
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger className="c-vpill inline-flex items-center gap-1" style={pillBtn} title="More actions">
              More
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44 p-1">
              <DropdownMenuGroup>
                <DropdownMenuCheckboxItem
                  checked={false}
                  closeOnClick
                  onCheckedChange={() => void remove(i)}
                >
                  {i.kind === "secret" ? "Delete" : "Disconnect"}
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      );
      const header = {
        leading: <Logo item={i} />,
        title: i.name,
        actions,
        sub: (
          <>
            <span className="c-vpill">{TYPE_LABEL[i.kind]}</span>
            <span className="c-dh-sub" style={{ margin: 0 }}>
              {i.account}
            </span>
          </>
        ),
      };

      // OAuth / API-key managed connection. The shared spine: Overview ·
      // Tools · Secrets · Used by · Activity. Recent emails (Gmail trust peek)
      // is an Advanced tab so the default view stays uncluttered.
      if (i.kind === "connection" && i.connection) {
        const c = i.connection;
        const isEmailConnection = c.app_name.toLowerCase().includes("gmail");
        const using = workersUsing(c, workers);
        const related = secretsForConnection(c, secrets);
        const advancedTabs = isEmailConnection ? ["Recent emails"] : [];
        const baseTabs = [
          {
            key: "Overview",
            label: "Overview",
            render: () => (
              <KV
                rows={[
                  ["App", humaniseAppName(c.app_name)],
                  ["Account", i.account],
                  ["Auth", "OAuth · managed token (rotates on reconnect)"],
                  ["Status", <StatusPill key="st" spec={STATUS_PILL[i.statusKey]} />],
                  ["Scopes", String(c.scopes?.length ?? 0)],
                  ["Connected", new Date(c.created_at).toLocaleDateString()],
                  ["Last used", formatLastUsed(c)],
                  ["Owner", resolveOwner(c.owner_id, members)],
                ]}
              />
            ),
          },
          {
            key: "Tools",
            label: "Tools",
            count: c.scopes?.length,
            render: () => <OAuthToolsPanel connection={c} />,
          },
          {
            key: "Secrets",
            label: "Secrets",
            count: related.length || undefined,
            render: () => (
              <ConnSecretsPanel connection={c} secrets={secrets} onChanged={() => void refresh()} />
            ),
          },
          {
            key: "Used by",
            label: "Used by",
            count: using.length || undefined,
            render: () => <UsedByPanel connection={c} workers={workers} />,
          },
          {
            key: "Activity",
            label: "Activity",
            render: () => <ActivityPanel connectionId={c.id} />,
          },
        ];
        const advancedRendered = advancedTabs
          .filter((t) => pinnedTabs.has(t))
          .map((t) => ({
            key: t,
            label: t,
            render: () => <EmailPeekPanel connectionId={c.id} />,
          }));
        return {
          header,
          tabs: [...baseTabs, ...advancedRendered],
          tabsTrailing: (
            <ConnAdvancedMenu advancedTabs={advancedTabs} pinned={pinnedTabs} onToggle={toggleAdvancedTab} />
          ),
        };
      }

      // MCP server connection. Same spine; the Tools tab reads live from the
      // server (allowed vs available), Config lives under Advanced.
      if (i.kind === "mcp" && i.connection) {
        const c = i.connection;
        const using = workersUsing(c, workers);
        const related = secretsForConnection(c, secrets);
        const advancedTabs = ["Config"];
        const baseTabs = [
          {
            key: "Overview",
            label: "Overview",
            render: () => (
              <KV
                rows={[
                  ["Server", c.mcp_label || c.app_name],
                  [
                    "Endpoint",
                    <span key="ep" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {c.mcp_url || c.mcp_command || "—"}
                    </span>,
                  ],
                  ["Transport", c.mcp_transport || "—"],
                  ["Auth secret", c.mcp_auth_secret ? <span key="as" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{c.mcp_auth_secret}</span> : "None"],
                  ["Status", <StatusPill key="st" spec={STATUS_PILL[i.statusKey]} />],
                  ["Tools", String(c.mcp_allowed_tools?.length ?? 0)],
                  ["Last used", formatLastUsed(c)],
                ]}
              />
            ),
          },
          {
            key: "Tools",
            label: "Tools",
            count: c.mcp_allowed_tools?.length,
            render: () => <McpToolsPanel connection={c} />,
          },
          {
            key: "Secrets",
            label: "Secrets",
            count: related.length || undefined,
            render: () => (
              <ConnSecretsPanel connection={c} secrets={secrets} onChanged={() => void refresh()} />
            ),
          },
          {
            key: "Used by",
            label: "Used by",
            count: using.length || undefined,
            render: () => <UsedByPanel connection={c} workers={workers} />,
          },
          {
            key: "Activity",
            label: "Activity",
            render: () => <ActivityPanel connectionId={c.id} />,
          },
        ];
        const advancedRendered = advancedTabs
          .filter((t) => pinnedTabs.has(t))
          .map((t) => ({
            key: t,
            label: t,
            render: () => (
              <pre style={codeBlock}>
                {JSON.stringify(
                  c.mcp_transport === "stdio" || c.mcp_command
                    ? { command: c.mcp_command, args: c.mcp_args ?? [], transport: c.mcp_transport ?? "stdio" }
                    : { url: c.mcp_url, transport: c.mcp_transport ?? "streamable_http" },
                  null,
                  2,
                )}
              </pre>
            ),
          }));
        return {
          header,
          tabs: [...baseTabs, ...advancedRendered],
          tabsTrailing: (
            <ConnAdvancedMenu advancedTabs={advancedTabs} pinned={pinnedTabs} onToggle={toggleAdvancedTab} />
          ),
        };
      }
      // secret
      const s = i.secret!;
      const usedByCount = s.used_by?.length ?? 0;
      return {
        header,
        tabs: [
          {
            key: "Overview",
            label: "Overview",
            render: () => (
              <KV
                rows={[
                  [
                    "Name",
                    <span key="nm" style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{s.name}</span>,
                  ],
                  ["Value", <SecretValueField key="val" name={s.name} />],
                  [
                    "Status",
                    <StatusPill
                      key="st"
                      spec={
                        s.status === "set"
                          ? { tone: "ok", label: "Set" }
                          : { tone: "err", label: "Not set" }
                      }
                    />,
                  ],
                  [
                    "Used by",
                    usedByCount > 0 ? (
                      <Link
                        href={`?tab=Used+by`}
                        style={{
                          color: "var(--accent)",
                          textDecoration: "underline",
                          textDecorationColor: "color-mix(in srgb, var(--accent) 40%, transparent)",
                          textUnderlineOffset: 3,
                        }}
                      >
                        {usedByCount} {usedByCount === 1 ? "worker" : "workers"}
                      </Link>
                    ) : (
                      <span style={{ color: "var(--muted-foreground)" }}>None</span>
                    ),
                  ],
                ]}
              />
            ),
          },
          {
            key: "Used by",
            label: "Used by",
            count: s.used_by?.length,
            render: () => (
              <div className="c-ltable">
                {(s.used_by ?? []).map((workerName) => {
                  const workerId = workersByName.get(workerName);
                  return workerId ? (
                    <Link
                      key={workerName}
                      href={`/workers/${encodeURIComponent(workerId)}`}
                      className="c-lrow"
                      style={{ gridTemplateColumns: "1fr", textDecoration: "none" }}
                    >
                      <div className="c-lprimary">
                        <div className="c-lp-tx">
                          <div className="nm">{workerName}</div>
                        </div>
                      </div>
                    </Link>
                  ) : (
                    <div key={workerName} className="c-lrow" style={{ gridTemplateColumns: "1fr" }}>
                      <div className="c-lprimary">
                        <div className="c-lp-tx">
                          <div className="nm">{workerName}</div>
                        </div>
                      </div>
                    </div>
                   );
                })}
                {(s.used_by?.length ?? 0) === 0 && <div style={pad}>Not used by any worker yet.</div>}
              </div>
            ),
          },
        ],
      };
    },
    add: {
      label: "Add",
      panel: {
        title: "Add a connection",
        render: () => (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 460 }}>
            <p style={pad}>Connect an app, register an MCP server, or store a secret.</p>
            {[
              ["Browse apps", "/connections/browse"],
              ["Add MCP server", "/connections/mcp"],
              ["Add secret", "/connections/secrets"],
            ].map(([label, href]) => (
              <Link
                key={href}
                href={href}
                className="c-lrow"
                style={{ gridTemplateColumns: "1fr auto", textDecoration: "none", border: "var(--bd-list)", borderRadius: "var(--radius-card)", padding: "12px 14px" }}
              >
                <div className="c-lprimary">
                  <div className="c-lp-tx">
                    <div className="nm">{label}</div>
                  </div>
                </div>
                <span className="c-cell m">→</span>
              </Link>
            ))}
          </div>
        ),
      },
    },
    states: {
      empty: {
        title: "No connections yet",
        help: "Connect an app, add an MCP server, or store a secret your workers can use.",
      },
      errorRetry: () => {
        setTimedOut(false);
        void refresh();
      },
    },
  };

  return <Collection config={config} />;
}

const pad: React.CSSProperties = { color: "var(--muted-foreground)", padding: "8px 2px" };
const pillBtn: React.CSSProperties = { padding: "6px 11px", fontSize: 12.5 };
const fieldStyle: React.CSSProperties = {
  background: "var(--bg-2)",
  border: "var(--bd-input)",
  borderRadius: "var(--radius-input)",
  padding: "8px 11px",
  fontSize: 13,
  color: "var(--ink)",
  outline: "none",
};
const codeBlock: React.CSSProperties = {
  border: "var(--bd-card)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-2)",
  color: "var(--ink-soft)",
  padding: 13,
  whiteSpace: "pre-wrap",
  overflow: "auto",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
};
