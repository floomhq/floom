"use client";

/**
 * Cloud overlay for CliCommandPanel.
 *
 * The engine's version stores the token in browser localStorage ("single-user
 * v0"). In cloud each workspace has its own PATs stored server-side.
 * This overlay replaces localStorage reads with real API calls:
 *   GET  /app/api/proxy/auth/tokens        — list tokens (no raw values)
 *   POST /app/api/proxy/auth/tokens        — create token (raw value once)
 *   DELETE /app/api/proxy/auth/tokens/:id  — revoke token
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";
const CLOUD_API_BASE =
  process.env.NEXT_PUBLIC_WORKEROS_API_BASE || "https://workeros-api.floom.dev";
const ACTIVE_WORKSPACE_STORAGE_KEY = "workeros.activeWorkspaceId";
const API_WORKERS_PATH = "/workers";

type McpTarget = "claude" | "codex" | "cursor" | "vscode" | "windsurf" | "generic";

const MCP_TARGETS: { value: McpTarget; label: string; hint: string }[] = [
  { value: "claude",   label: "Claude",   hint: "~/.claude/settings.json" },
  { value: "codex",    label: "Codex",    hint: "paste generic snippet into Codex MCP config" },
  { value: "cursor",   label: "Cursor",   hint: "~/.cursor/mcp.json" },
  { value: "vscode",   label: "VS Code",  hint: ".vscode/mcp.json" },
  { value: "windsurf", label: "Windsurf", hint: "~/.codeium/windsurf/mcp_config.json" },
  { value: "generic",  label: "Generic",  hint: "prints snippet — paste manually" },
];

type Token = {
  id: string;
  workspace_id: string;
  name: string;
  created_at: string;
  last_used_at?: string | null;
};

function maskToken(raw: string): string {
  if (!raw) return "";
  if (raw.length <= 8) return "•".repeat(raw.length);
  return `${raw.slice(0, 12)}${"•".repeat(20)}${raw.slice(-4)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildEnvPrefix(token: string): string {
  return [
    `export WORKEROS_API_BASE=${shellQuote(CLOUD_API_BASE)}`,
    `export WORKEROS_API_TOKEN=${shellQuote(token)}`,
  ].join("\n");
}

function buildMcpSnippet(target: McpTarget, token: string): string {
  const command = target === "codex"
    ? "workeros mcp install --target generic"
    : `workeros mcp install --target ${target}`;
  const note = target === "codex"
    ? "\n# Codex uses a manual MCP config paste today; the command prints the server snippet."
    : "";
  return `${buildEnvPrefix(token)}\nnpm i -g @floomhq/workeros\n${command}${note}`;
}

function activeWorkspaceHeaders(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  if (typeof window === "undefined") return next;
  const workspaceId = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  if (workspaceId && workspaceId !== "local-default") {
    next.set("x-workeros-workspace", workspaceId);
  }
  return next;
}

async function readJsonOrThrow<T>(response: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // keep the original HTTP status as the fallback message below
  }
  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "detail" in body
        ? String((body as { detail?: unknown }).detail)
        : response.statusText || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body as T;
}

export function CliCommandPanel() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [newTokenRaw, setNewTokenRaw] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");
  const [creating, setCreating] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [mcpTarget, setMcpTarget] = useState<McpTarget>("claude");
  const [loading, setLoading] = useState(true);
  const [tokenError, setTokenError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setTokenError(null);
    fetch(`${API_BASE}/auth/tokens`, { headers: activeWorkspaceHeaders() })
      .then((r) => readJsonOrThrow<Token[] | { value?: Token[] }>(r))
      .then((d) => {
        // API returns {value: [...], Count: N} or a plain array
        const list = Array.isArray(d) ? d : Array.isArray(d?.value) ? d.value : [];
        setTokens(list as Token[]);
        setLoading(false);
      })
      .catch((err: Error) => {
        setTokenError(err.message || "Failed to load workspace tokens");
        setLoading(false);
      });
  }, []);

  async function createToken() {
    const name = newTokenName.trim() || "default";
    try {
      const r = await fetch(`${API_BASE}/auth/tokens`, {
        method: "POST",
        headers: activeWorkspaceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name }),
      });
      const data = await readJsonOrThrow<Token & { token?: string }>(r);
      setNewTokenRaw(data.token ?? null);
      setRevealed(true);
      setNewTokenName("");
      setCreating(false);
      setTokens((prev) => [data, ...prev]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create workspace token");
    }
  }

  async function revokeToken(id: string) {
    try {
      const response = await fetch(`${API_BASE}/auth/tokens/${id}`, {
        method: "DELETE",
        headers: activeWorkspaceHeaders(),
      });
      if (!response.ok) await readJsonOrThrow(response);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      if (newTokenRaw && tokens.find((t) => t.id === id)) setNewTokenRaw(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke workspace token");
    }
  }

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(""), 1200);
  }

  const displayToken = newTokenRaw
    ? (revealed ? newTokenRaw : maskToken(newTokenRaw))
    : null;

  const tokenForSnippet = newTokenRaw ?? "<YOUR_CLOUD_PAT>";
  const snippets = useMemo(() => ({
    cli: `${buildEnvPrefix(tokenForSnippet)}\nnpm i -g @floomhq/workeros\nworkeros whoami\nworkeros workers list`,
    mcp: buildMcpSnippet(mcpTarget, tokenForSnippet),
    api: `curl -sS ${CLOUD_API_BASE}${API_WORKERS_PATH} \\\n  -H "x-floom-token: ${tokenForSnippet}"`,
  }), [mcpTarget, tokenForSnippet]);

  const activeMcpTarget = MCP_TARGETS.find((t) => t.value === mcpTarget)!;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Workspace API tokens</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Tokens for CLI, MCP, and direct API access for the active workspace on{" "}
            <code className="font-mono">workeros-api.floom.dev</code>. Use them
            as <code className="font-mono">x-floom-token</code>; OSS secrets use{" "}
            <code className="font-mono">x-floom-secret</code> on{" "}
            <code className="font-mono">workers-api.floom.dev</code>.
            Raw values are shown only once and cannot access other workspaces.
          </p>
        </div>

        {/* Newly created token — show raw value once */}
        {newTokenRaw && (
          <div className="rounded-[var(--radius-button)] border border-blue-500/40 bg-blue-500/5 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-blue-600 dark:text-blue-400">
                New token created — copy it now, it won&apos;t be shown again.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                onClick={() => { setNewTokenRaw(null); setRevealed(false); }}
                title="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate font-mono text-xs bg-[var(--bg-2)] border border-line rounded px-2 py-1.5">
                {displayToken}
              </code>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setRevealed((v) => !v)}>
                {revealed ? <EyeOff className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
                {revealed ? "Hide" : "Reveal"}
              </Button>
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void copy(newTokenRaw, "new-token")}>
                {copiedKey === "new-token" ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                {copiedKey === "new-token" ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}

        {/* Token list */}
        {loading ? (
          <div className="text-xs text-muted-foreground">Loading tokens…</div>
        ) : tokenError ? (
          <div className="rounded-[var(--radius-button)] border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {tokenError}
          </div>
        ) : tokens.length === 0 ? (
          <div className="text-xs text-muted-foreground">No tokens yet. Create one below.</div>
        ) : (
          <div className="space-y-2">
            {tokens.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] border border-line bg-[var(--bg-2)] px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{t.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    Created {new Date(t.created_at).toLocaleDateString()}
                    {t.last_used_at ? ` · Last used ${new Date(t.last_used_at).toLocaleDateString()}` : " · Never used"}
                    {t.workspace_id ? ` · ${t.workspace_id}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => void revokeToken(t.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Create new token */}
        {creating ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Token name (e.g. cursor, ci)"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createToken(); if (e.key === "Escape") setCreating(false); }}
              autoFocus
              className="flex-1 rounded-[var(--radius-button)] border border-line bg-[var(--bg-2)] px-3 py-2 text-xs outline-none font-mono"
            />
            <Button size="sm" className="h-9 px-3 text-xs" onClick={() => void createToken()}>Create</Button>
            <Button variant="ghost" size="sm" className="h-9 px-3 text-xs" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="h-8 px-3 text-xs gap-1.5" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            New token
          </Button>
        )}
      </section>

      <div className="space-y-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Setup commands</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Drop these into a terminal to install the CLI, add the MCP server, or hit the API directly.
          </p>
        </div>
        <Tabs defaultValue="cli">
          <TabsList>
            <TabsTrigger value="cli">CLI</TabsTrigger>
            <TabsTrigger value="mcp">MCP</TabsTrigger>
            <TabsTrigger value="api">API</TabsTrigger>
          </TabsList>
          <TabsContent value="cli">
            <SnippetBox text={snippets.cli} copied={copiedKey === "cli"} onCopy={() => void copy(snippets.cli, "cli")} />
          </TabsContent>
          <TabsContent value="mcp" className="space-y-2">
            <div className="flex items-center gap-1 flex-wrap">
              {MCP_TARGETS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setMcpTarget(t.value)}
                  className={
                    `inline-flex h-8 items-center rounded-[var(--radius-button)] border px-3 text-xs font-medium transition-colors ` +
                    (mcpTarget === t.value
                      ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
                      : "border-line bg-[var(--bg-2)] text-muted-foreground hover:text-foreground hover:bg-muted")
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Writes to <code className="font-mono">{activeMcpTarget.hint}</code>
            </p>
            <SnippetBox text={snippets.mcp} copied={copiedKey === "mcp"} onCopy={() => void copy(snippets.mcp, "mcp")} />
          </TabsContent>
          <TabsContent value="api">
            <SnippetBox text={snippets.api} copied={copiedKey === "api"} onCopy={() => void copy(snippets.api, "api")} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function SnippetBox({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="relative rounded-[var(--radius-button)] border border-line bg-[var(--bg-2)] dark:bg-[#1a1a1a]">
      <button
        type="button"
        onClick={onCopy}
        className="absolute right-2 top-2 inline-flex h-7 items-center gap-1 rounded-[var(--radius-button)] border border-line bg-card px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="whitespace-pre-wrap text-xs leading-relaxed font-mono p-3 pr-20 text-foreground dark:text-[#a8e6a3] overflow-auto">
        <code>{text}</code>
      </pre>
    </div>
  );
}
