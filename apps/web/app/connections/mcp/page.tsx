"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  Link as LinkIcon,
  Loader2,
  Plus,
  Server,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConnectionsTabs } from "@/components/connections/ConnectionsTabs";
import { api } from "@/lib/api";
import type { ConnectionItem, SecretItem } from "@/lib/types";

// ---------- types ----------

type McpConnection = ConnectionItem & {
  kind: "mcp";
  mcp_label: string;
  mcp_url: string;
};

// Subset of Claude Desktop / VS Code / Cursor mcpServers shape
interface ParsedMcpServer {
  key: string;
  label: string;
  url: string | null;
  headers: Record<string, string>;
  isStdio: boolean;
  selected: boolean;
}

// ---------- helpers ----------

function parseMcpClientConfig(raw: string): ParsedMcpServer[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON");
  }

  // Accept top-level mcpServers key or direct object
  const servers: Record<string, unknown> =
    (parsed.mcpServers as Record<string, unknown>) ??
    parsed;

  return Object.entries(servers).map(([key, value]) => {
    const entry = (value ?? {}) as Record<string, unknown>;
    const isStdio = !!entry.command || !!entry.args;
    const url =
      typeof entry.url === "string" ? entry.url :
      typeof entry.endpoint === "string" ? entry.endpoint :
      null;
    const rawHeaders = (entry.headers ?? {}) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v === "string") headers[k] = v;
    }
    return { key, label: key, url, headers, isStdio, selected: !isStdio && !!url };
  });
}

function truncateUrl(url: string, max = 48): string {
  if (url.length <= max) return url;
  try {
    const u = new URL(url);
    const host = u.hostname + (u.port ? `:${u.port}` : "");
    const path = u.pathname.length > 20 ? `…${u.pathname.slice(-16)}` : u.pathname;
    return `${host}${path}`;
  } catch {
    return url.slice(0, max - 1) + "…";
  }
}

// ---------- component ----------

export default function McpConnectionsPage() {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  // Add-form state
  const [formOpen, setFormOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [authSecret, setAuthSecret] = useState("");
  const [allowedTools, setAllowedTools] = useState("");
  const [saving, setSaving] = useState(false);

  // Import-from-config state
  const [importOpen, setImportOpen] = useState(false);
  const [importRaw, setImportRaw] = useState("");
  const [importParsed, setImportParsed] = useState<ParsedMcpServer[] | null>(null);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await api.connections.list();
      setConnections(all.filter((c) => c.kind === "mcp") as McpConnection[]);
    } catch {
      toast.error("Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    api.secrets.list().then(setSecrets).catch(() => setSecrets([]));
  }, [load]);

  async function handleCreate() {
    if (!label.trim() || !url.trim()) {
      toast.error("Label and URL are required");
      return;
    }
    setSaving(true);
    try {
      await api.connections.createMcp({
        label: label.trim(),
        url: url.trim(),
        auth_secret: authSecret || null,
        allowed_tools: parseTools(allowedTools),
      });
      toast.success(`MCP server "${label.trim()}" saved`);
      setLabel(""); setUrl(""); setAuthSecret(""); setAllowedTools("");
      setFormOpen(false);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(conn: McpConnection) {
    setDeleting(conn.id);
    try {
      await api.connections.delete(conn.id);
      toast.success(`${conn.mcp_label} removed`);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setDeleting(null);
    }
  }

  async function handleTest(conn: McpConnection) {
    setTesting(conn.id);
    try {
      const result = await api.connections.test(conn.id);
      if (result.status === "valid") {
        toast.success(`${conn.mcp_label}: connection is valid`);
      } else {
        toast.error(`${conn.mcp_label}: ${result.reason || "test failed"}`);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTesting(null);
    }
  }

  function handleParseImport() {
    setImportError("");
    if (!importRaw.trim()) return;
    try {
      const items = parseMcpClientConfig(importRaw.trim());
      if (items.length === 0) {
        setImportError("No server entries found in the config.");
        return;
      }
      setImportParsed(items);
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : "Parse error");
    }
  }

  function toggleImportItem(key: string) {
    setImportParsed((prev) =>
      prev ? prev.map((item) => item.key === key ? { ...item, selected: !item.selected } : item) : null
    );
  }

  async function handleImport() {
    if (!importParsed) return;
    const toImport = importParsed.filter((item) => item.selected && !item.isStdio && item.url);
    if (toImport.length === 0) {
      toast.error("No importable servers selected");
      return;
    }
    setImporting(true);
    let ok = 0;
    for (const item of toImport) {
      try {
        // Extract bearer token from Authorization header if present
        const authHeader = item.headers["Authorization"] ?? item.headers["authorization"] ?? "";
        const bearerMatch = authHeader.match(/^Bearer\s+(.+)/i);
        const secretName = bearerMatch ? null : null; // We can't create secrets automatically — user must pick
        await api.connections.createMcp({
          label: item.label,
          url: item.url!,
          auth_secret: secretName,
          allowed_tools: [],
        });
        ok++;
      } catch {
        toast.error(`Failed to import "${item.label}"`);
      }
    }
    if (ok > 0) {
      toast.success(`${ok} MCP server${ok > 1 ? "s" : ""} imported`);
      setImportOpen(false);
      setImportRaw("");
      setImportParsed(null);
      await load();
    }
    setImporting(false);
  }

  return (
    <>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">
            Connect apps via OAuth so workers can read and write on your behalf.
          </p>
        </header>

        <ConnectionsTabs />

        {/* Actions row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-medium">MCP servers</h2>
            <p className="text-sm text-muted-foreground">
              HTTP/SSE tool servers exposed to agent workers at run time.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => { setImportOpen((v) => !v); setFormOpen(false); }}
            >
              <Upload className="size-4" />
              Import config
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => { setFormOpen((v) => !v); setImportOpen(false); }}
            >
              <Plus className="size-4" />
              Add MCP server
            </Button>
          </div>
        </div>

        {/* Add form */}
        {formOpen && (
          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4">
            <p className="text-sm font-medium mb-3">New MCP server</p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mcp-label" className="text-xs text-muted-foreground">Label</Label>
                <Input
                  id="mcp-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="github-mcp"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-auth-secret" className="text-xs text-muted-foreground">Auth secret (bearer token)</Label>
                <select
                  id="mcp-auth-secret"
                  value={authSecret}
                  onChange={(e) => setAuthSecret(e.target.value)}
                  className="flex h-9 w-full rounded-lg border border-line-strong bg-paper px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  <option value="">No bearer token</option>
                  {secrets.map((s) => (
                    <option key={s.name} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="mcp-url" className="text-xs text-muted-foreground">URL</Label>
                <Input
                  id="mcp-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="mcp-tools" className="text-xs text-muted-foreground">
                  Allowed tools{" "}
                  <span className="text-muted-foreground/60">(optional — comma-separated, empty = all tools)</span>
                </Label>
                <Textarea
                  id="mcp-tools"
                  value={allowedTools}
                  onChange={(e) => setAllowedTools(e.target.value)}
                  placeholder="list_pull_requests, get_repo"
                  className="min-h-16"
                />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button type="button" size="sm" onClick={handleCreate} disabled={saving || !label.trim() || !url.trim()}>
                {saving ? <><Loader2 className="size-3.5 animate-spin" /> Saving...</> : "Save MCP server"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Import form */}
        {importOpen && (
          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 space-y-3">
            <div>
              <p className="text-sm font-medium">Import from client config</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Paste a Claude Desktop, Cursor, or VS Code{" "}
                <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">mcpServers</code>{" "}
                JSON. Only HTTP/SSE servers with a <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">url</code> field can be imported —
                stdio-only servers need an HTTP endpoint first.
              </p>
            </div>
            <Textarea
              value={importRaw}
              onChange={(e) => { setImportRaw(e.target.value); setImportParsed(null); setImportError(""); }}
              placeholder={'{\n  "mcpServers": {\n    "github": {\n      "url": "https://api.githubcopilot.com/mcp/"\n    }\n  }\n}'}
              className="font-mono text-xs min-h-32"
            />
            {importError && <p className="text-xs text-destructive">{importError}</p>}

            {!importParsed && (
              <Button type="button" size="sm" variant="outline" onClick={handleParseImport} disabled={!importRaw.trim()}>
                Preview servers
              </Button>
            )}

            {importParsed && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Detected servers — select to import
                </p>
                <div className="space-y-1">
                  {importParsed.map((item) => (
                    <div
                      key={item.key}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                        item.isStdio || !item.url
                          ? "border-[var(--border-default)] bg-muted/30 opacity-60 cursor-not-allowed"
                          : "border-[var(--border-default)] bg-[var(--bg-app)] cursor-pointer hover:bg-muted/40"
                      }`}
                      onClick={() => { if (!item.isStdio && item.url) toggleImportItem(item.key); }}
                    >
                      <div className={`size-4 rounded border flex items-center justify-center shrink-0 ${
                        item.selected ? "bg-[var(--accent)] border-[var(--accent)]" : "border-[var(--border-default)]"
                      }`}>
                        {item.selected && <Check className="size-3 text-white" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="font-medium truncate block">{item.label}</span>
                        {item.url && (
                          <span className="text-xs text-muted-foreground truncate block">{truncateUrl(item.url)}</span>
                        )}
                        {item.isStdio && (
                          <span className="text-xs text-muted-foreground italic">
                            stdio server — needs an HTTP/SSE endpoint to be imported
                          </span>
                        )}
                        {!item.isStdio && !item.url && (
                          <span className="text-xs text-muted-foreground italic">no url field — cannot import</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleImport}
                    disabled={importing || !importParsed.some((i) => i.selected && !i.isStdio && i.url)}
                  >
                    {importing ? <><Loader2 className="size-3.5 animate-spin" /> Importing...</> : `Import ${importParsed.filter((i) => i.selected && !i.isStdio && i.url).length} server(s)`}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => { setImportParsed(null); }}
                  >
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => { setImportOpen(false); setImportRaw(""); setImportParsed(null); setImportError(""); }}
                    disabled={importing}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Table */}
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
          {/* Header row */}
          <div className="hidden md:grid grid-cols-[32px_minmax(0,1fr)_minmax(0,1.8fr)_minmax(0,.9fr)_minmax(0,1fr)_auto] gap-4 px-3 py-2 border-b border-[var(--border-default)] bg-[var(--bg-2)] text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
            <span />
            <span>Label</span>
            <span>URL</span>
            <span>Auth</span>
            <span>Tools</span>
            <span className="text-right pr-1">Actions</span>
          </div>

          {loading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse border-b border-[var(--border-default)] last:border-b-0 bg-muted/20" />
            ))
          ) : connections.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <Server className="size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No MCP servers saved yet.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFormOpen(true)}
              >
                <Plus className="size-4" />
                Add your first MCP server
              </Button>
            </div>
          ) : (
            connections.map((conn) => (
              <McpRow
                key={conn.id}
                conn={conn}
                deleting={deleting === conn.id}
                testing={testing === conn.id}
                onDelete={() => void handleDelete(conn)}
                onTest={() => void handleTest(conn)}
              />
            ))
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          MCP servers declared in a worker&apos;s{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">worker.yml</code>{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">connections</code> list are
          connected at run time. Auth secrets are resolved by name — their values are never
          stored here.
        </p>
      </div>
    </>
  );
}

function McpRow({
  conn,
  deleting,
  testing,
  onDelete,
  onTest,
}: {
  conn: McpConnection;
  deleting: boolean;
  testing: boolean;
  onDelete: () => void;
  onTest: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copyUrl() {
    if (!conn.mcp_url) return;
    navigator.clipboard.writeText(conn.mcp_url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="group grid grid-cols-[32px_1fr_auto] md:grid-cols-[32px_minmax(0,1fr)_minmax(0,1.8fr)_minmax(0,.9fr)_minmax(0,1fr)_auto] gap-3 md:gap-4 items-center px-3 py-2.5 border-b border-[var(--border-default)] last:border-b-0 hover:bg-[var(--active-nav-bg)] transition-colors">
      {/* Icon */}
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-app)]">
        <Server className="size-3.5 text-muted-foreground" />
      </div>

      {/* Label */}
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{conn.mcp_label}</p>
        <p className="md:hidden text-xs text-muted-foreground truncate">{conn.mcp_url}</p>
      </div>

      {/* URL */}
      <div className="hidden md:flex items-center gap-1.5 min-w-0">
        <span className="text-xs text-muted-foreground truncate flex-1">{truncateUrl(conn.mcp_url ?? "", 52)}</span>
        <button
          type="button"
          onClick={copyUrl}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted transition-opacity"
          title="Copy URL"
        >
          {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5 text-muted-foreground" />}
        </button>
      </div>

      {/* Auth */}
      <span className="hidden md:inline text-xs text-muted-foreground truncate">
        {conn.mcp_auth_secret ? (
          <code className="bg-muted px-1 py-0.5 rounded font-mono">{conn.mcp_auth_secret}</code>
        ) : "None"}
      </span>

      {/* Tools */}
      <span className="hidden md:inline text-xs text-muted-foreground truncate">
        {(conn.mcp_allowed_tools ?? []).length > 0
          ? `${(conn.mcp_allowed_tools ?? []).length} tool${(conn.mcp_allowed_tools ?? []).length === 1 ? "" : "s"}`
          : "All tools"}
      </span>

      {/* Actions */}
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onTest}
          disabled={testing}
          className="h-7 text-xs px-2 hidden md:flex"
          title="Test connection"
        >
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : "Test"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          disabled={deleting}
          title="Remove MCP server"
        >
          {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

function parseTools(value: string): string[] {
  return value.split(/[,\n]/g).map((t) => t.trim()).filter(Boolean);
}
