"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Server, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ConnectionItem, SecretItem } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { BrandLogo } from "@/components/connections/BrandLogo";
import {
  type UnifiedConn,
  STATUS_PILL,
  TYPE_LABEL,
  toUnified,
} from "@/lib/connections/unify";

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

export default function ConnectionsCollection({
  initialConnections,
}: {
  initialConnections: ConnectionItem[];
}) {
  const [connections, setConnections] = useState<ConnectionItem[]>(initialConnections);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);

  const refresh = async () => {
    const [c, s] = await Promise.allSettled([api.connections.list(), api.secrets.list()]);
    if (c.status === "fulfilled") setConnections(c.value);
    if (s.status === "fulfilled") setSecrets(s.value);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const items = useMemo(() => toUnified(connections, secrets), [connections, secrets]);

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
    view: { default: "list", grid: true },
    columns: {
      template: "1.8fr 110px 1fr 120px 40px",
      headers: ["Connects to", "Type", "Detail", "Status", ""],
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
      const fullHref =
        i.kind === "mcp"
          ? `/connections/mcp/${i.id}`
          : i.kind === "secret"
            ? `/connections/secrets`
            : `/connections/${i.id}`;
      const actions = (
        <>
          <button type="button" className="c-addbtn" style={pillBtn} onClick={() => void test(i)}>
            Test
          </button>
          <Link href={fullHref} className="c-vpill" style={{ padding: "6px 11px" }}>
            Open full page →
          </Link>
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
              render: () => (
                <div style={pad}>
                  Recent activity lives on the{" "}
                  <Link href={fullHref} style={{ color: "var(--accent)" }}>
                    full connection page
                  </Link>
                  .
                </div>
              ),
            },
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
                {(s.used_by ?? []).map((w) => (
                  <div key={w} className="c-lrow" style={{ gridTemplateColumns: "1fr" }}>
                    <div className="c-lprimary">
                      <div className="c-lp-tx">
                        <div className="nm">{w}</div>
                      </div>
                    </div>
                  </div>
                ))}
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
                style={{ gridTemplateColumns: "1fr auto", textDecoration: "none", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px" }}
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

  return <Collection config={config} />;
}

const pad: React.CSSProperties = { color: "var(--muted-foreground)", padding: "8px 2px" };
const pillBtn: React.CSSProperties = { padding: "6px 11px", fontSize: 12.5 };
const codeBlock: React.CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 12,
  background: "var(--bg-2)",
  color: "var(--ink-soft)",
  padding: 13,
  whiteSpace: "pre-wrap",
  overflow: "auto",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
};
