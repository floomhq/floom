"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Mail, Server, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ConnectionItem, RunSummary, SecretItem, WorkerSummary } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { LoadingState } from "@/components/collection/CollectionStates";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { RunStatusBadge } from "@/components/RunStatus";
import {
  type UnifiedConn,
  STATUS_PILL,
  TYPE_LABEL,
  toUnified,
} from "@/lib/connections/unify";

// ---------------------------------------------------------------------------
// #813 — Setup required callout
// Computes which connection slugs are needed by workers but not yet connected.
// missing_connections is populated by the backend (#556) on WorkerSummary.
// ---------------------------------------------------------------------------

function computeMissingBySlug(
  workers: WorkerSummary[],
  connections: ConnectionItem[],
): Map<string, string[]> {
  // Build the set of connected app slugs (lower-cased, composio kind only)
  const connected = new Set(
    connections
      .filter((c) => !c.kind || c.kind === "composio")
      .map((c) => c.app_name.toLowerCase()),
  );

  // Aggregate: slug -> worker names that still need it
  const missing = new Map<string, string[]>();
  for (const worker of workers) {
    for (const slug of worker.missing_connections ?? []) {
      const key = slug.toLowerCase();
      if (!connected.has(key)) {
        if (!missing.has(key)) missing.set(key, []);
        missing.get(key)!.push(worker.name);
      }
    }
  }
  return missing;
}

function SetupRequiredCallout({ missingBySlug }: { missingBySlug: Map<string, string[]> }) {
  if (missingBySlug.size === 0) return null;
  const slugs = Array.from(missingBySlug.keys());
  const totalWorkers = new Set(Array.from(missingBySlug.values()).flat()).size;
  return (
    <div
      className="flex items-start gap-3 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--accent-soft)] px-4 py-3 text-sm text-[var(--ink)]"
      role="alert"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <span className="font-medium">Setup required: </span>
        {totalWorkers} worker{totalWorkers !== 1 ? "s" : ""} need{totalWorkers === 1 ? "s" : ""}{" "}
        {slugs.length === 1 ? (
          <Link
            href={`/connections/connect/${encodeURIComponent(slugs[0])}?return_to=${encodeURIComponent("/connections")}`}
            className="font-medium underline underline-offset-2"
          >
            {slugs[0]}
          </Link>
        ) : (
          <>
            {slugs.slice(0, -1).map((slug, i) => (
              <span key={slug}>
                <Link
                  href={`/connections/connect/${encodeURIComponent(slug)}?return_to=${encodeURIComponent("/connections")}`}
                  className="font-medium underline underline-offset-2"
                >
                  {slug}
                </Link>
                {i < slugs.length - 2 ? ", " : ""}
              </span>
            ))}
            {" and "}
            <Link
              href={`/connections/connect/${encodeURIComponent(slugs[slugs.length - 1])}?return_to=${encodeURIComponent("/connections")}`}
              className="font-medium underline underline-offset-2"
            >
              {slugs[slugs.length - 1]}
            </Link>
          </>
        )}
        .
      </div>
    </div>
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

function formatLastUsed(connection: ConnectionItem) {
  if (!connection.last_used_at) return "—";
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

export default function ConnectionsCollection({
  initialConnections,
}: {
  initialConnections: ConnectionItem[];
}) {
  const router = useRouter();
  const [connections, setConnections] = useState<ConnectionItem[]>(initialConnections);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [loading, setLoading] = useState(initialConnections.length === 0);

  const refresh = async (initial = false) => {
    const [c, s, w] = await Promise.allSettled([
      api.connections.list(),
      api.secrets.list(),
      api.workers.list(),
    ]);
    if (c.status === "fulfilled") setConnections(c.value);
    if (s.status === "fulfilled") setSecrets(s.value);
    if (w.status === "fulfilled") setWorkers(w.value);
    if (initial) setLoading(false);
  };

  useEffect(() => {
    void refresh(true);
  }, []);

  const items = useMemo(() => toUnified(connections, secrets), [connections, secrets]);

  // #813: compute which slugs workers need but haven't been connected yet
  const missingBySlug = useMemo(
    () => computeMissingBySlug(workers, connections),
    [workers, connections],
  );

  // #1226: secret `used_by` is a list of worker NAMES; resolve each to its id so
  // the "Used by" rows link to the worker detail. Falls back to plain text when
  // a name can't be matched (e.g. the worker was deleted/renamed).
  const workerIdByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of workers) map.set(w.name, w.id);
    return map;
  }, [workers]);

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
    idOf: (i) => i.id,
    searchOf: (i) => `${i.name} ${i.account} ${TYPE_LABEL[i.kind]}`,
    tagsOf: (i) =>
      ({ type: [i.kind], status: [i.statusKey] }) as Partial<Record<TagFamilyKey, string[]>>,
    tags: {
      type: [
        { value: "connection", label: "Connection" },
        { value: "mcp", label: "MCP" },
        { value: "secret", label: "Secret" },
      ],
      status: [
        { value: "active", label: "active" },
        { value: "reauth", label: "reauth" },
        { value: "error", label: "error" },
      ],
    },
    counts: [
      { value: items.length, label: "total" },
      { value: items.filter((i) => i.statusKey === "active").length, label: "active" },
      { value: items.filter((i) => i.statusKey === "reauth").length, label: "reauth" },
      { value: items.filter((i) => i.statusKey === "error").length, label: "error" },
    ],
    view: { default: "grid", grid: true },
    columns: {
      template: "1.8fr 110px 1fr 120px 40px",
      headers: ["Connects to", "Type", "Detail", "Status", ""],
      headerTransparent: true,
    },
    row: (i) => {
      const reconnectHref =
        i.kind === "connection" && i.connection
          ? `/connections/connect/${encodeURIComponent(i.connection.app_name)}?return_to=${encodeURIComponent("/connections")}`
          : null;
      return {
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
          // #1371 — Reconnect CTA surfaces on the row for reauth/expired connections.
          ...(i.statusKey === "reauth" && reconnectHref
            ? [{ label: "Reconnect", onSelect: () => router.push(reconnectHref) }]
            : []),
          { label: "Test", onSelect: () => void test(i) },
          { label: "Remove", onSelect: () => void remove(i), danger: true },
        ],
      };
    },
    card: (i) => {
      const reconnectHref =
        i.kind === "connection" && i.connection
          ? `/connections/connect/${encodeURIComponent(i.connection.app_name)}?return_to=${encodeURIComponent("/connections")}`
          : null;
      return {
        leading: <Logo item={i} />,
        name: i.name,
        description: i.account,
        status: STATUS_PILL[i.statusKey],
        // #1371 — quick-action Reconnect for reauth cards (visible on hover).
        ...(i.statusKey === "reauth" && reconnectHref
          ? {
              quickActions: [
                {
                  label: "Reconnect",
                  onClick: () => router.push(reconnectHref),
                },
              ],
            }
          : {}),
      };
    },
    detail: (i) => {
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
          <button type="button" className="c-vpill" style={pillBtn} onClick={() => void remove(i)}>
            Remove
          </button>
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
      if (i.kind === "connection" && i.connection) {
        const c = i.connection;
        const isEmailConnection = c.app_name.toLowerCase().includes("gmail");
        return {
          header,
          tabs: [
            {
              key: "Overview",
              label: "Overview",
              render: () => (
                <KV
                  rows={[
                    ["App", c.app_name],
                    ["Account", i.account],
                    ["Status", STATUS_PILL[i.statusKey].label],
                    ["Scopes", String(c.scopes?.length ?? 0)],
                    ["Connected", new Date(c.created_at).toLocaleDateString()],
                    ["Last used", formatLastUsed(c)],
                    ["Owner", c.owner_id || "—"],
                  ]}
                />
              ),
            },
            {
              key: "Permissions",
              label: "Permissions",
              count: c.scopes?.length,
              render: () => (
                <div className="c-ltable">
                  {(c.scopes ?? []).map((s) => (
                    <div key={s} className="c-lrow" style={{ gridTemplateColumns: "1fr" }}>
                      <div className="c-lprimary">
                        <div className="c-lp-tx">
                          <div className="nm">{s}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {(c.scopes?.length ?? 0) === 0 && <div style={pad}>No scopes recorded.</div>}
                </div>
              ),
            },
            {
              key: "Activity",
              label: "Activity",
              render: () => <ActivityPanel connectionId={c.id} />,
            },
            ...(isEmailConnection
              ? [
                  {
                    key: "Recent emails",
                    label: "Recent emails",
                    render: () => <EmailPeekPanel connectionId={c.id} />,
                  },
                ]
              : []),
          ],
        };
      }
      if (i.kind === "mcp" && i.connection) {
        const c = i.connection;
        return {
          header,
          tabs: [
            {
              key: "Overview",
              label: "Overview",
              render: () => (
                <KV
                  rows={[
                    ["Server", c.mcp_label || c.app_name],
                    ["Endpoint", c.mcp_url || c.mcp_command || "—"],
                    ["Transport", c.mcp_transport || "—"],
                    ["Status", STATUS_PILL[i.statusKey].label],
                    ["Tools", String(c.mcp_allowed_tools?.length ?? 0)],
                  ]}
                />
              ),
            },
            {
              key: "Tools",
              label: "Tools",
              count: c.mcp_allowed_tools?.length,
              render: () => (
                <div className="c-ltable">
                  {(c.mcp_allowed_tools ?? []).map((t) => (
                    <div key={t} className="c-lrow" style={{ gridTemplateColumns: "1fr" }}>
                      <div className="c-lprimary">
                        <div className="c-lp-tx">
                          <div className="nm" style={{ fontFamily: "var(--font-mono)" }}>
                            {t}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {(c.mcp_allowed_tools?.length ?? 0) === 0 && <div style={pad}>No tools listed.</div>}
                </div>
              ),
            },
            {
              key: "Config",
              label: "Config",
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
            },
          ],
        };
      }
      // secret
      const s = i.secret!;
      return {
        header,
        tabs: [
          {
            key: "Overview",
            label: "Overview",
            render: () => (
              <KV
                rows={[
                  ["Name", s.name],
                  ["Value", "••••••••••••"],
                  ["Status", s.status === "set" ? "Set" : "Missing"],
                  ["Used by", String(s.used_by?.length ?? 0)],
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
                {(s.used_by ?? []).map((w) => {
                  const id = workerIdByName.get(w);
                  const inner = (
                    <div className="c-lprimary">
                      <div className="c-lp-tx">
                        <div className="nm">{w}</div>
                      </div>
                    </div>
                  );
                  return id ? (
                    <Link
                      key={w}
                      href={`/workers?sel=${encodeURIComponent(id)}`}
                      className="c-lrow"
                      style={{ gridTemplateColumns: "1fr", textDecoration: "none", color: "inherit" }}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div key={w} className="c-lrow" style={{ gridTemplateColumns: "1fr" }}>
                      {inner}
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
    },
  };

  return (
    <>
      <SetupRequiredCallout missingBySlug={missingBySlug} />
      <Collection config={config} />
    </>
  );
}

const pad: React.CSSProperties = { color: "var(--muted-foreground)", padding: "8px 2px" };
const pillBtn: React.CSSProperties = { padding: "6px 11px", fontSize: 12.5 };
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
