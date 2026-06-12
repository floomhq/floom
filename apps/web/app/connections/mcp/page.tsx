"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  Server,
  Terminal,
  Trash2,
  Zap,
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
};

type McpTransport = "streamable_http" | "sse" | "stdio";

type McpConfigPayload = {
  label: string;
  transport?: McpTransport;
  url?: string | null;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  auth_secret?: string | null;
  allowed_tools?: string[];
};

const MCP_INSTALL_TARGETS = [
  { label: "Codex / Generic", target: "generic", command: "workeros mcp install --target generic" },
  { label: "Claude", target: "claude", command: "workeros mcp install --target claude" },
  { label: "Cursor", target: "cursor", command: "workeros mcp install --target cursor" },
  { label: "VS Code", target: "vscode", command: "workeros mcp install --target vscode" },
  { label: "Windsurf", target: "windsurf", command: "workeros mcp install --target windsurf" },
  { label: "Continue", target: "continue", command: "workeros mcp install --target continue" },
] as const;

const IMPORT_CONFIG_COMMAND = "workeros connections import-mcp-config ~/.claude/settings.json";
const DEFAULT_MCP_JSON = `{
  "label": "github",
  "transport": "streamable_http",
  "url": "https://example.com/mcp",
  "auth_secret": "GITHUB_PAT",
  "allowed_tools": []
}`;

// Subset of Claude Desktop / VS Code / Cursor mcpServers shape
interface ParsedMcpServer {
  key: string;
  label: string;
  url: string | null;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  headers: Record<string, string>;
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
    const command = typeof entry.command === "string" ? entry.command : null;
    const args = Array.isArray(entry.args) ? entry.args.filter((item): item is string => typeof item === "string") : [];
    const isStdio = !!command || args.length > 0;
    const url =
      typeof entry.url === "string" ? entry.url :
      typeof entry.endpoint === "string" ? entry.endpoint :
      null;
    const transport = isStdio ? "stdio" : (String(entry.transport || "").toLowerCase() === "sse" ? "sse" : "streamable_http");
    const rawEnv = (entry.env ?? {}) as Record<string, unknown>;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawEnv)) {
      if (typeof v === "string") env[k] = v;
    }
    const rawHeaders = (entry.headers ?? {}) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v === "string") headers[k] = v;
    }
    const cwd = typeof entry.cwd === "string" ? entry.cwd : null;
    return { key, label: key, url, transport, command, args, env, cwd, headers, selected: isStdio ? !!command : !!url };
  });
}

function validateMcpJsonConfig(raw: string): { payload?: McpConfigPayload; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid JSON" };
  }
  return validateMcpPayload(parsed);
}

function validateMcpPayload(raw: unknown): { payload?: McpConfigPayload; error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Config must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(label)) {
    return { error: "label must be 1-64 letters, digits, underscores, or hyphens" };
  }

  const transport = normalizeTransport(record.transport);
  if (!transport) {
    return { error: "transport must be streamable_http, sse, or stdio" };
  }

  const url = typeof record.url === "string" && record.url.trim() ? record.url.trim() : null;
  const command = typeof record.command === "string" && record.command.trim() ? record.command.trim() : null;
  if (transport === "stdio") {
    if (!command) return { error: "stdio configs must include command" };
    if (url) return { error: "stdio configs cannot include url" };
  } else {
    if (!url) return { error: "HTTP and SSE configs must include url" };
    if (!/^https?:\/\//i.test(url)) return { error: "url must start with http:// or https://" };
    if (command) return { error: "HTTP and SSE configs cannot include command" };
  }

  const args = normalizeStringArray(record.args, "args");
  if (typeof args === "string") return { error: args };
  const allowedTools = normalizeStringArray(record.allowed_tools, "allowed_tools");
  if (typeof allowedTools === "string") return { error: allowedTools };
  const env = normalizeEnv(record.env);
  if (typeof env === "string") return { error: env };

  const authSecret =
    typeof record.auth_secret === "string" && record.auth_secret.trim() ? record.auth_secret.trim() : null;
  if (authSecret && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authSecret)) {
    return { error: "auth_secret must be a valid secret name" };
  }
  if (authSecret && transport === "stdio") {
    return { error: "stdio configs cannot include auth_secret" };
  }

  const cwd = typeof record.cwd === "string" && record.cwd.trim() ? record.cwd.trim() : null;
  return {
    payload: {
      label,
      transport,
      url,
      command,
      args,
      env,
      cwd,
      auth_secret: authSecret,
      allowed_tools: allowedTools,
    },
  };
}

function normalizeTransport(value: unknown): McpTransport | null {
  if (value === undefined || value === null || value === "") return "streamable_http";
  if (value === "streamable_http" || value === "sse" || value === "stdio") return value;
  return null;
}

function normalizeStringArray(value: unknown, field: string): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return `${field} must be an array`;
  const cleaned: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      return `${field} entries must be non-empty strings`;
    }
    cleaned.push(item.trim());
  }
  return cleaned;
}

function normalizeEnv(value: unknown): Record<string, string> | string {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return "env must be an object";
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return "env keys must be valid environment variable names";
    }
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      return "env values must be non-empty secret references";
    }
    const secretRef = rawValue.trim();
    if (!/^secret:[A-Za-z_][A-Za-z0-9_]*$/.test(secretRef)) {
      return "env values must use secret:SECRET_NAME";
    }
    env[name] = secretRef;
  }
  return env;
}

function serverSummary(item: ParsedMcpServer): string {
  if (item.transport === "stdio") {
    return [item.command, ...item.args].filter(Boolean).join(" ");
  }
  return item.url ?? "";
}

function connectionSummary(conn: McpConnection): string {
  if ((conn.mcp_transport ?? "streamable_http") === "stdio") {
    return [conn.mcp_command, ...(conn.mcp_args ?? [])].filter(Boolean).join(" ");
  }
  return conn.mcp_url ?? "";
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
  // #566: track which MCP row is expanded for the in-place peek
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Concept A: install Floom Workers into an AI client (secondary, collapsed)
  const [installOpen, setInstallOpen] = useState(false);
  const [installTarget, setInstallTarget] = useState<(typeof MCP_INSTALL_TARGETS)[number]["target"]>("generic");
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  // Concept B: add an MCP server for workers, JSON first.
  const [formOpen, setFormOpen] = useState(false);
  const [mode, setMode] = useState<"json" | "form" | "import">("json");
  const [serverJson, setServerJson] = useState(DEFAULT_MCP_JSON);

  // Manual add-form state
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<McpTransport>("streamable_http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [cwd, setCwd] = useState("");
  const [authSecret, setAuthSecret] = useState("");
  const [allowedTools, setAllowedTools] = useState("");
  const [saving, setSaving] = useState(false);

  // Import-from-config (JSON) state
  const [importRaw, setImportRaw] = useState("");
  const [importParsed, setImportParsed] = useState<ParsedMcpServer[] | null>(null);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const serverJsonValidation = useMemo(() => validateMcpJsonConfig(serverJson), [serverJson]);

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

  function resetForm() {
    setLabel(""); setTransport("streamable_http"); setUrl(""); setCommand("");
    setArgs(""); setEnv(""); setCwd(""); setAuthSecret(""); setAllowedTools("");
    setServerJson(DEFAULT_MCP_JSON);
    setImportRaw(""); setImportParsed(null); setImportError("");
  }

  function openForm(initialMode: "json" | "form" | "import") {
    resetForm();
    setMode(initialMode);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    resetForm();
  }

  async function handleCreateFromJson() {
    const { payload, error } = serverJsonValidation;
    if (error || !payload) {
      toast.error(error || "MCP config is invalid");
      return;
    }
    setSaving(true);
    try {
      await api.connections.createMcp(payload);
      toast.success(`MCP server "${payload.label}" saved`);
      closeForm();
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateFromForm() {
    if (!label.trim()) {
      toast.error("Label is required");
      return;
    }
    if (transport === "stdio" && !command.trim()) {
      toast.error("Command is required for stdio MCP servers");
      return;
    }
    if (transport !== "stdio" && !url.trim()) {
      toast.error("URL is required for HTTP/SSE MCP servers");
      return;
    }
    let parsedEnv: Record<string, string> = {};
    try {
      parsedEnv = transport === "stdio" ? parseEnv(env) : {};
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Environment is invalid");
      return;
    }
    const validation = validateMcpPayload({
      label: label.trim(),
      transport,
      url: transport === "stdio" ? null : url.trim(),
      command: transport === "stdio" ? command.trim() : null,
      args: transport === "stdio" ? parseArgs(args) : [],
      env: parsedEnv,
      cwd: transport === "stdio" ? cwd.trim() || null : null,
      auth_secret: transport === "stdio" ? null : authSecret || null,
      allowed_tools: parseTools(allowedTools),
    });
    if (validation.error || !validation.payload) {
      toast.error(validation.error || "MCP config is invalid");
      return;
    }
    setSaving(true);
    try {
      await api.connections.createMcp(validation.payload);
      toast.success(`MCP server "${label.trim()}" saved`);
      closeForm();
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

  function copyCommand(value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedCommand(value);
      setTimeout(() => setCopiedCommand(null), 1500);
    });
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
    const toImport = importParsed.filter((item) => item.selected && (item.transport === "stdio" ? item.command : item.url));
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
        const secretName = bearerMatch ? null : null; // We cannot create secrets automatically; user must pick.
        await api.connections.createMcp({
          label: item.label,
          transport: item.transport,
          url: item.transport === "stdio" ? null : item.url!,
          command: item.transport === "stdio" ? item.command : null,
          args: item.args,
          env: normalizeImportedEnv(item.env),
          cwd: item.cwd,
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
      closeForm();
      await load();
    }
    setImporting(false);
  }

  const currentInstallCommand =
    MCP_INSTALL_TARGETS.find((target) => target.target === installTarget)?.command ?? MCP_INSTALL_TARGETS[0].command;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">
          Connect apps via OAuth so workers can read and write on your behalf.
        </p>
      </header>

      <ConnectionsTabs />

      {/* ============================================================= */}
      {/* Concept A — Use Floom Workers IN your AI client (secondary)   */}
      {/* ============================================================= */}
      <section className="rounded-xl [border:var(--bd-card)] bg-[var(--bg-card)]">
        <button
          type="button"
          onClick={() => setInstallOpen((v) => !v)}
          aria-expanded={installOpen}
          className="flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left transition-colors hover:bg-[var(--active-nav-bg)]"
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg [border:var(--bd-card)] bg-[var(--bg-app)]">
            <Terminal className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-medium">Use Floom in your AI client</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Install Floom as an MCP server in Claude, Cursor, VS Code, or another client.
            </p>
          </div>
          <ChevronDown
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${installOpen ? "rotate-180" : ""}`}
          />
        </button>

        {installOpen && (
          <div className="space-y-3 [border-top:var(--bd-div)] px-4 py-4">
            <div className="flex flex-wrap gap-1.5">
              {MCP_INSTALL_TARGETS.map((target) => (
                <button
                  key={target.target}
                  type="button"
                  onClick={() => setInstallTarget(target.target)}
                  className={`rounded-[var(--radius-button)] [border:var(--bd-pill)] px-2.5 py-1 text-xs font-medium transition-colors ${
                    installTarget === target.target
                      ? "bg-[var(--ink)] text-[var(--bg-app)]"
                      : "bg-[var(--bg-card)] text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {target.label}
                </button>
              ))}
            </div>
            <CommandBlock
              title="Run in your terminal"
              command={currentInstallCommand}
              copied={copiedCommand === currentInstallCommand}
              onCopy={() => copyCommand(currentInstallCommand)}
            />
            <p className="text-xs text-muted-foreground">
              Installs Floom&apos; tools into your AI client. To connect a third-party MCP
              server <em>into</em> Floom instead, use the section below.
            </p>
          </div>
        )}
      </section>

      {/* ============================================================= */}
      {/* Concept B — MCP servers your workers can use (primary)        */}
      {/* ============================================================= */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">MCP servers your workers can use</h2>
          <p className="text-sm text-muted-foreground">
            Third-party MCP tool servers exposed to your agent workers at run time.
          </p>
        </div>
        {!formOpen && (
          <Button type="button" size="sm" onClick={() => openForm("json")}>
            <Plus className="size-4" />
            Add MCP server
          </Button>
        )}
      </div>

      {/* Single add flow: JSON config first, with form and bulk import as secondary paths. */}
      {formOpen && (
        <div className="rounded-xl [border:var(--bd-card)] bg-[var(--bg-card)] p-4">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">Add MCP server</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Paste a JSON config. Use secret names, not secret values.
              </p>
            </div>
          <div className="inline-flex rounded-lg [border:var(--bd-card)] bg-[var(--bg-app)] p-0.5">
            <button
              type="button"
              onClick={() => setMode("json")}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === "json"
                  ? "bg-[var(--bg-card)] text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              JSON config
            </button>
            <button
              type="button"
              onClick={() => setMode("form")}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === "form"
                  ? "bg-[var(--bg-card)] text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Form
            </button>
            <button
              type="button"
              onClick={() => setMode("import")}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === "import"
                  ? "bg-[var(--bg-card)] text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Import from JSON
            </button>
          </div>
          </div>

          {mode === "json" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="mcp-server-json" className="text-xs text-muted-foreground">
                  Server JSON
                </Label>
                <span
                  className={`inline-flex items-center gap-1 text-xs ${
                    serverJsonValidation.error ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"
                  }`}
                >
                  {serverJsonValidation.error ? (
                    <AlertCircle className="size-3.5" />
                  ) : (
                    <CheckCircle2 className="size-3.5" />
                  )}
                  {serverJsonValidation.error || "Valid JSON config"}
                </span>
              </div>
              <Textarea
                id="mcp-server-json"
                value={serverJson}
                onChange={(e) => setServerJson(e.target.value)}
                spellCheck={false}
                className="min-h-64 font-mono text-xs leading-5"
              />
              <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
                <p>HTTP/SSE: label, transport, url, auth_secret, allowed_tools.</p>
                <p>Stdio: label, transport, command, args, env, cwd.</p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreateFromJson}
                  disabled={saving || Boolean(serverJsonValidation.error)}
                >
                  {saving ? <><Loader2 className="size-3.5 animate-spin" /> Saving...</> : "Save MCP server"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={closeForm} disabled={saving}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : mode === "form" ? (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-label" className="text-xs text-muted-foreground">Name</Label>
                  <Input
                    id="mcp-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="github-mcp"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-transport" className="text-xs text-muted-foreground">Transport</Label>
                  <select
                    id="mcp-transport"
                    value={transport}
                    onChange={(e) => setTransport(e.target.value as McpTransport)}
                    className="flex h-9 w-full rounded-[var(--radius-input)] [border:var(--bd-input)] bg-[var(--bg-2)] px-3 text-sm outline-none"
                  >
                    <option value="streamable_http">HTTP</option>
                    <option value="sse">SSE</option>
                    <option value="stdio">Stdio (command)</option>
                  </select>
                </div>
                {transport !== "stdio" && (
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-auth-secret" className="text-xs text-muted-foreground">Auth secret (bearer token)</Label>
                  <select
                    id="mcp-auth-secret"
                    value={authSecret}
                    onChange={(e) => setAuthSecret(e.target.value)}
                    className="flex h-9 w-full rounded-[var(--radius-input)] [border:var(--bd-input)] bg-[var(--bg-2)] px-3 text-sm outline-none"
                  >
                    <option value="">No bearer token</option>
                    {secrets.map((s) => (
                      <option key={s.name} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                </div>
                )}
                {transport !== "stdio" ? (
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="mcp-url" className="text-xs text-muted-foreground">URL</Label>
                  <Input
                    id="mcp-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com/mcp"
                  />
                </div>
                ) : (
                  <>
                    <div className="space-y-1.5 md:col-span-2">
                      <Label htmlFor="mcp-command" className="text-xs text-muted-foreground">Command</Label>
                      <Input
                        id="mcp-command"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="npx"
                      />
                    </div>
                    <div className="space-y-1.5 md:col-span-2">
                      <Label htmlFor="mcp-args" className="text-xs text-muted-foreground">
                        Arguments <span className="text-muted-foreground/60">(one per line)</span>
                      </Label>
                      <Textarea
                        id="mcp-args"
                        value={args}
                        onChange={(e) => setArgs(e.target.value)}
                        placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/workspace"
                        className="min-h-20 font-mono text-xs"
                      />
                    </div>
                    <div className="space-y-1.5 md:col-span-2">
                      <Label htmlFor="mcp-env" className="text-xs text-muted-foreground">
                        Environment <span className="text-muted-foreground/60">(KEY=secret:SECRET_NAME, one per line)</span>
                      </Label>
                      <Textarea
                        id="mcp-env"
                        value={env}
                        onChange={(e) => setEnv(e.target.value)}
                        placeholder="GITHUB_TOKEN=secret:GITHUB_PAT"
                        className="min-h-16 font-mono text-xs"
                      />
                    </div>
                    <div className="space-y-1.5 md:col-span-2">
                      <Label htmlFor="mcp-cwd" className="text-xs text-muted-foreground">Working directory</Label>
                      <Input
                        id="mcp-cwd"
                        value={cwd}
                        onChange={(e) => setCwd(e.target.value)}
                        placeholder="/workspace"
                      />
                    </div>
                  </>
                )}
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="mcp-tools" className="text-xs text-muted-foreground">
                    Allowed tools{" "}
                    <span className="text-muted-foreground/60">(optional, comma-separated, empty = all tools)</span>
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
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreateFromForm}
                  disabled={saving || !label.trim() || (transport === "stdio" ? !command.trim() : !url.trim())}
                >
                  {saving ? <><Loader2 className="size-3.5 animate-spin" /> Saving...</> : "Save MCP server"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={closeForm} disabled={saving}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Paste a Claude Desktop, Cursor, or VS Code{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">mcpServers</code>{" "}
                JSON. URL and stdio command servers can both be imported. Env literals are converted to secret references.
              </p>
              <Textarea
                value={importRaw}
                onChange={(e) => { setImportRaw(e.target.value); setImportParsed(null); setImportError(""); }}
                placeholder={'{\n  "mcpServers": {\n    "github": {\n      "url": "https://api.githubcopilot.com/mcp/"\n    }\n  }\n}'}
                className="min-h-32 font-mono text-xs"
              />
              {importError && <p className="text-xs text-destructive">{importError}</p>}

              {!importParsed && (
                <div className="flex items-center gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={handleParseImport} disabled={!importRaw.trim()}>
                    Preview servers
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={closeForm}>
                    Cancel
                  </Button>
                </div>
              )}

              {importParsed && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Detected servers: select to import
                  </p>
                  <div className="space-y-1">
                    {importParsed.map((item) => (
                      <div
                        key={item.key}
                        className={`flex items-center gap-3 rounded-[var(--radius-button)] [border:var(--bd-card)] px-3 py-2.5 text-sm transition-colors ${
                          item.transport !== "stdio" && !item.url
                            ? "cursor-not-allowed bg-muted/30 opacity-60"
                            : "cursor-pointer bg-[var(--bg-app)] hover:bg-muted/40"
                        }`}
                        onClick={() => { if (item.transport === "stdio" || item.url) toggleImportItem(item.key); }}
                      >
                        <div className={`flex size-4 shrink-0 items-center justify-center rounded-[var(--radius-button)] [border:var(--bd-pill)] ${
                          item.selected ? "bg-[var(--accent)]" : "bg-[var(--bg-2)]"
                        }`}>
                          {item.selected && <Check className="size-3 text-white" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{item.label}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.transport === "stdio" ? serverSummary(item) : truncateUrl(item.url ?? "")}
                          </span>
                          {item.transport !== "stdio" && !item.url && (
                            <span className="text-xs italic text-muted-foreground">no url field, cannot import</span>
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
                      disabled={importing || !importParsed.some((i) => i.selected && (i.transport === "stdio" ? i.command : i.url))}
                    >
                      {importing ? <><Loader2 className="size-3.5 animate-spin" /> Importing...</> : `Import ${importParsed.filter((i) => i.selected && (i.transport === "stdio" ? i.command : i.url)).length} server(s)`}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setImportParsed(null)}
                    >
                      Back
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={closeForm}
                      disabled={importing}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Saved servers list */}
      <div className="overflow-hidden rounded-xl [border:var(--bd-card)] bg-[var(--bg-card)]">
        {/* Header row */}
        <div className="hidden grid-cols-[32px_minmax(0,1fr)_minmax(0,1.8fr)_minmax(0,.9fr)_minmax(0,1fr)_auto] gap-4 [border-bottom:var(--bd-div)] bg-[var(--bg-2)] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:grid">
          <span />
          <span>Name</span>
          <span>Endpoint</span>
          <span>Auth</span>
          <span>Tools</span>
          <span className="pr-1 text-right">Actions</span>
        </div>

        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse [border-bottom:var(--bd-div)] bg-muted/20 last:[border-bottom:0]" />
          ))
        ) : connections.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-[var(--bg-app)]">
              <Server className="size-5 text-muted-foreground/50" />
            </div>
            <div>
              <p className="text-sm font-medium">No MCP servers yet</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Add a server to give your workers extra tools.
              </p>
            </div>
            {!formOpen && (
              <Button type="button" size="sm" variant="outline" onClick={() => openForm("json")}>
                <Plus className="size-4" />
                Add MCP server
              </Button>
            )}
          </div>
        ) : (
          connections.map((conn) => (
            <McpRow
              key={conn.id}
              conn={conn}
              deleting={deleting === conn.id}
              testing={testing === conn.id}
              expanded={expandedId === conn.id}
              onDelete={() => void handleDelete(conn)}
              onTest={() => void handleTest(conn)}
              onToggle={() => setExpandedId((prev) => prev === conn.id ? null : conn.id)}
            />
          ))
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        MCP servers declared in a worker&apos;s{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">worker.yml</code>{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">connections</code> list are
        connected at run time. Auth secrets are resolved by name, their values are never
        stored here. Prefer the terminal? Run{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">{IMPORT_CONFIG_COMMAND}</code>.
      </p>
    </div>
  );
}

function CommandBlock({
  title,
  command,
  copied,
  onCopy,
}: {
  title: string;
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-lg [border:var(--bd-card)] bg-[var(--bg-app)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex size-7 items-center justify-center rounded-md [border:var(--bd-card)] bg-[var(--bg-card)] text-muted-foreground hover:text-foreground"
          title="Copy command"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-[var(--ink)] px-3 py-2 text-xs text-[var(--bg-app)]">
        <code>{command}</code>
      </pre>
    </div>
  );
}

function McpRow({
  conn,
  deleting,
  testing,
  expanded,
  onDelete,
  onTest,
  onToggle,
}: {
  conn: McpConnection;
  deleting: boolean;
  testing: boolean;
  expanded?: boolean;
  onDelete: () => void;
  onTest: () => void;
  onToggle?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copyUrl() {
    const value = connectionSummary(conn);
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const toolCount = (conn.mcp_allowed_tools ?? []).length;
  const toolLabel = toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : "All tools";
  const statusLabel = conn.status === "active" ? "Active" : conn.status === "failed" ? "Failed" : conn.status === "expired" ? "Expired" : "Inactive";
  const isActive = conn.status === "active";

  return (
    <div className="[border-bottom:var(--bd-div)] last:[border-bottom:0] transition-colors">
      {/* Clickable row */}
      <div
        role={onToggle ? "button" : undefined}
        tabIndex={onToggle ? 0 : undefined}
        onClick={onToggle}
        onKeyDown={onToggle ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } } : undefined}
        className={`group grid grid-cols-[32px_1fr_auto] items-center gap-3 px-3 py-2.5 md:grid-cols-[32px_minmax(0,1fr)_minmax(0,1.8fr)_minmax(0,.9fr)_minmax(0,1fr)_auto] md:gap-4 ${onToggle ? "cursor-pointer select-none hover:bg-[var(--active-nav-bg)]" : "hover:bg-[var(--active-nav-bg)]"} transition-colors`}
      >
        {/* Icon */}
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg [border:var(--bd-card)] bg-[var(--bg-app)]">
          <Server className="size-3.5 text-muted-foreground" />
        </div>

        {/* Label */}
        <div className="min-w-0 flex items-center gap-1.5">
          {onToggle && (
            <ChevronRight
              className={`size-3.5 shrink-0 text-muted-foreground/50 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{conn.mcp_label}</p>
            <p className="truncate text-xs text-muted-foreground md:hidden">{connectionSummary(conn)}</p>
          </div>
        </div>

        {/* URL */}
        <div
          className="hidden min-w-0 items-center gap-1.5 md:flex"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="flex-1 truncate text-xs text-muted-foreground">
            {(conn.mcp_transport ?? "streamable_http") === "stdio"
              ? connectionSummary(conn)
              : truncateUrl(conn.mcp_url ?? "", 52)}
          </span>
          <button
            type="button"
            onClick={copyUrl}
            className="rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
            title="Copy URL"
          >
            {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5 text-muted-foreground" />}
          </button>
        </div>

        {/* Auth */}
        <span className="hidden truncate text-xs text-muted-foreground md:inline">
          {conn.mcp_auth_secret ? (
            <code className="rounded bg-muted px-1 py-0.5 font-mono">{conn.mcp_auth_secret}</code>
          ) : "None"}
        </span>

        {/* Tools */}
        <span className="hidden truncate text-xs text-muted-foreground md:inline">
          {toolLabel}
        </span>

        {/* Actions */}
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onTest}
            disabled={testing}
            className="hidden h-7 px-2 text-xs md:flex"
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

      {/* Expanded peek */}
      {expanded && (
        <div className="[border-top:var(--bd-div)] bg-[color-mix(in_srgb,var(--active-nav-bg)_60%,transparent)] px-3 py-3 md:pl-[52px]">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className={`inline-flex items-center rounded-[var(--radius-pill)] [border:var(--bd-pill)] px-2 py-0.5 text-xs font-medium ${isActive ? "bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] text-[var(--positive)]" : "bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] text-[var(--negative)]"}`}>
              {statusLabel}
            </span>
            <span className="text-[var(--ink-soft)]">{toolLabel}</span>
            <span className="text-[var(--ink-soft)] font-mono text-xs">
              {conn.mcp_transport ?? "streamable_http"}
            </span>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={onTest}
              disabled={testing}
            >
              <Zap className={`size-3 ${testing ? "animate-pulse" : ""}`} />
              {testing ? "Testing..." : "Test"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => { window.location.href = `/connections/mcp/${conn.id}`; }}
            >
              <ExternalLink className="size-3" />
              Open
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function parseTools(value: string): string[] {
  return value.split(/[,\n]/g).map((t) => t.trim()).filter(Boolean);
}

function parseArgs(value: string): string[] {
  return value.split(/\n/g).map((item) => item.trim()).filter(Boolean);
}

function parseEnv(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split(/\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) throw new Error("Environment entries must use KEY=secret:SECRET_NAME");
    const key = trimmed.slice(0, index).trim();
    const val = trimmed.slice(index + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error("Environment keys must be valid environment variable names");
    }
    if (!/^secret:[A-Za-z_][A-Za-z0-9_]*$/.test(val)) {
      throw new Error("Environment values must use secret:SECRET_NAME references");
    }
    result[key] = val;
  }
  return result;
}

function normalizeImportedEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const placeholder = value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
    result[key] = value.startsWith("secret:")
      ? value
      : placeholder
        ? `secret:${placeholder[1]}`
        : `secret:${key}`;
  }
  return result;
}
