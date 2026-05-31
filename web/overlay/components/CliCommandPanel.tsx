"use client";

/**
 * Cloud overlay for CliCommandPanel.
 *
 * The engine's version stores the token in browser localStorage ("single-user
 * v0"). In cloud each user has their own per-user PATs stored server-side.
 * This overlay replaces localStorage reads with real API calls:
 *   GET  /app/api/proxy/auth/tokens        — list tokens (no raw values)
 *   POST /app/api/proxy/auth/tokens        — create token (raw value once)
 *   DELETE /app/api/proxy/auth/tokens/:id  — revoke token
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";

type McpTarget = "claude" | "cursor" | "vscode" | "windsurf" | "generic";

const MCP_TARGETS: { value: McpTarget; label: string; hint: string }[] = [
  { value: "claude",   label: "Claude",   hint: "~/.claude/settings.json" },
  { value: "cursor",   label: "Cursor",   hint: "~/.cursor/mcp.json" },
  { value: "vscode",   label: "VS Code",  hint: ".vscode/mcp.json" },
  { value: "windsurf", label: "Windsurf", hint: "~/.codeium/windsurf/mcp_config.json" },
  { value: "generic",  label: "Generic",  hint: "prints snippet — paste manually" },
];

type Token = {
  id: string;
  name: string;
  created_at: string;
  last_used_at?: string | null;
};

function maskToken(raw: string): string {
  if (!raw) return "";
  if (raw.length <= 8) return "•".repeat(raw.length);
  return `${raw.slice(0, 12)}${"•".repeat(20)}${raw.slice(-4)}`;
}

function buildMcpSnippet(target: McpTarget): string {
  return `npx @floomhq/workeros install --target ${target}`;
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

  useEffect(() => {
    fetch(`${API_BASE}/auth/tokens`)
      .then((r) => r.json())
      .then((d) => {
        // API returns {value: [...], Count: N} or a plain array
        const list = Array.isArray(d) ? d : Array.isArray(d?.value) ? d.value : [];
        setTokens(list as Token[]);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function createToken() {
    const name = newTokenName.trim() || "default";
    const r = await fetch(`${API_BASE}/auth/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await r.json() as Token & { token?: string };
    setNewTokenRaw(data.token ?? null);
    setRevealed(true);
    setNewTokenName("");
    setCreating(false);
    setTokens((prev) => [data, ...prev]);
  }

  async function revokeToken(id: string) {
    await fetch(`${API_BASE}/auth/tokens/${id}`, { method: "DELETE" });
    setTokens((prev) => prev.filter((t) => t.id !== id));
    if (newTokenRaw && tokens.find((t) => t.id === id)) setNewTokenRaw(null);
  }

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(""), 1200);
  }

  const displayToken = newTokenRaw
    ? (revealed ? newTokenRaw : maskToken(newTokenRaw))
    : null;

  const snippets = useMemo(() => ({
    cli: "npm i -g @floomhq/workeros\nworkeros login",
    mcp: buildMcpSnippet(mcpTarget),
    api: `curl -sS ${API_BASE.replace("/api/proxy", "")}/api/workers \\\n  -H "x-floom-token: <YOUR_TOKEN>"`,
  }), [mcpTarget]);

  const activeMcpTarget = MCP_TARGETS.find((t) => t.value === mcpTarget)!;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Your API tokens</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Personal Access Tokens for CLI, MCP, and direct API access. Each token is scoped to your account.
            Raw values are shown only once — save them somewhere safe.
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
                    `h-7 px-2.5 text-xs rounded-[var(--radius-button)] border transition-colors ` +
                    (mcpTarget === t.value
                      ? "border-blue-500 bg-blue-500 text-white"
                      : "border-line bg-card text-muted-foreground hover:text-foreground hover:bg-muted")
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
