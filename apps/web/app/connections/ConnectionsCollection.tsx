"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Copy, Eye, EyeOff, Mail, Server, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ConnectionItem, RunSummary, SecretItem, WorkerSummary, WorkspaceMember } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { LoadingState } from "@/components/collection/CollectionStates";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { RunStatusBadge } from "@/components/RunStatus";
import { StatusPill } from "@/components/collection/StatusPill";
import {
  type UnifiedConn,
  STATUS_PILL,
  TYPE_LABEL,
  toUnified,
  collectionCounts,
  humaniseAppName,
} from "@/lib/connections/unify";

// ---------------------------------------------------------------------------
// #1233: Resolve owner_id to display name / email.
// Works client-side from the workspace members list fetched on load.
// If backend later populates owner_display_name on ConnectionItem, prefer that.
// ---------------------------------------------------------------------------
function resolveOwner(
  ownerId: string | null | undefined,
  members: WorkspaceMember[],
): string {
  if (!ownerId) return "Not set";
  const member = members.find((m) => m.user_id === ownerId);
  if (member) return member.display_name || member.email || ownerId;
  // Fallback: truncate UUID so it's friendlier than the full 36-char string
  return ownerId.length > 8 ? `${ownerId.slice(0, 8)}...` : ownerId;
}

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
            {humaniseAppName(slugs[0])}
          </Link>
        ) : (
          <>
            {slugs.slice(0, -1).map((slug, i) => (
              <span key={slug}>
                <Link
                  href={`/connections/connect/${encodeURIComponent(slug)}?return_to=${encodeURIComponent("/connections")}`}
                  className="font-medium underline underline-offset-2"
                >
                  {humaniseAppName(slug)}
                </Link>
                {i < slugs.length - 2 ? ", " : ""}
              </span>
            ))}
            {" and "}
            <Link
              href={`/connections/connect/${encodeURIComponent(slugs[slugs.length - 1])}?return_to=${encodeURIComponent("/connections")}`}
              className="font-medium underline underline-offset-2"
            >
              {humaniseAppName(slugs[slugs.length - 1])}
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

export default function ConnectionsCollection({
  initialConnections,
}: {
  initialConnections: ConnectionItem[];
}) {
  const [connections, setConnections] = useState<ConnectionItem[]>(initialConnections);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  // #1234: always start loading so secrets render on first paint (not after SSR
  // connections cause loading=false while secrets are still in-flight).
  // #1269/#1279: the 10s safety timeout in the effect below guarantees loading
  // resolves, so this never becomes an infinite skeleton on a hung API.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (initial = false) => {
    const [c, s, w, m] = await Promise.allSettled([
      api.connections.list(),
      api.secrets.list(),
      api.workers.list(),
      (api.members?.list?.() ?? Promise.resolve({ members: [] as WorkspaceMember[] }))
        .then((r) => r.members)
        .catch(() => [] as WorkspaceMember[]),
    ]);
    if (c.status === "fulfilled") setConnections(c.value);
    if (s.status === "fulfilled") setSecrets(s.value);
    if (w.status === "fulfilled") setWorkers(w.value);
    if (m.status === "fulfilled") setMembers(m.value);
    if (initial) setLoading(false);
  };

  useEffect(() => {
    void refresh(true);
    // Safety timeout: if the API proxy hangs, stop the skeleton after 25 s. But
    // only surface an error when we have NOTHING to show — with SSR/cached data
    // we keep showing it instead of flashing "Something went wrong" on a slow
    // backend (consistent with the workers/runs cache-first behavior).
    const timeout = setTimeout(() => {
      setLoading((prev) => {
        if (prev && initialConnections.length === 0) {
          setError("Could not load connections. Check your connection and try again.");
        }
        return false;
      });
    }, 25_000);
    return () => clearTimeout(timeout);
  }, []);

  const items = useMemo(() => toUnified(connections, secrets), [connections, secrets]);

  // #813: compute which slugs workers need but haven't been connected yet
  const missingBySlug = useMemo(
    () => computeMissingBySlug(workers, connections),
    [workers, connections],
  );

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
    // round-09 #6: secrets are NOT connections — count connections + secrets
    // separately and scope the active/reauth/error health tiles to real
    // connections, so a "set" secret can never read as an "active connection".
    counts: collectionCounts(items),
    view: { default: "grid", grid: true },
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
                    ["Status", <StatusPill spec={STATUS_PILL[i.statusKey]} />],
                    ["Scopes", String(c.scopes?.length ?? 0)],
                    ["Connected", new Date(c.created_at).toLocaleDateString()],
                    ["Last used", formatLastUsed(c)],
                    ["Owner", resolveOwner(c.owner_id, members)],
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
                    [
                      "Endpoint",
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                        {c.mcp_url || c.mcp_command || "—"}
                      </span>,
                    ],
                    ["Transport", c.mcp_transport || "—"],
                    ["Status", <StatusPill spec={STATUS_PILL[i.statusKey]} />],
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
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{s.name}</span>,
                  ],
                  ["Value", <SecretValueField name={s.name} />],
                  [
                    "Status",
                    <StatusPill
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
        setError(null);
        setLoading(true);
        void refresh(true);
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
