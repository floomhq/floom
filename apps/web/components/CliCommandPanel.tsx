/* <!-- S15: drop <CliCommandPanel /> into the API access tab after S12 lands --> */
"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { McpToolCatalog } from "@/components/McpToolCatalog";

const SECRET_STORAGE_KEYS = ["floom_secret", "FLOOM_SECRET", "workeros_api_secret"];
const API_BASE = "https://workers-api.floom.dev";
const PROXY_BASE = "/api/proxy";

type McpTarget = "claude" | "codex" | "cursor" | "vscode" | "windsurf" | "generic";

const MCP_TARGETS: { value: McpTarget; label: string; hint: string }[] = [
  { value: "claude",   label: "Claude",   hint: "~/.claude/settings.json" },
  { value: "codex",    label: "Codex",    hint: "prints a generic snippet for Codex MCP config" },
  { value: "cursor",   label: "Cursor",   hint: "~/.cursor/mcp.json" },
  { value: "vscode",   label: "VS Code",  hint: ".vscode/mcp.json" },
  { value: "windsurf", label: "Windsurf", hint: "~/.codeium/windsurf/mcp_config.json" },
  { value: "generic",  label: "Generic",  hint: "prints snippet — paste manually" },
];

function readStoredSecret(): string {
  if (typeof window === "undefined") return "";
  for (const key of SECRET_STORAGE_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function maskSecret(secret: string): string {
  // Federico 2026-05-29: show a full-length-style masked key like any other app
  // (first 4 + a run of bullets + last 4), not a truncated "924a…fe59". The
  // bullet run is fixed-width so it does not leak the secret's exact length.
  if (!secret) return "<YOUR_OSS_FLOOM_SECRET>";
  if (secret.length <= 8) return "•".repeat(secret.length);
  return `${secret.slice(0, 4)}${"•".repeat(24)}${secret.slice(-4)}`;
}

function buildMcpSnippet(target: McpTarget): string {
  const cliTarget = target === "codex" ? "generic" : target;
  const note = target === "codex"
    ? "\n# Codex uses a manual MCP config paste today; the command prints the server snippet."
    : "";
  return `npm i -g @floomhq/workeros\nworkeros mcp add --target ${cliTarget}${note}`;
}

// The OSS MCP server is HTTP transport: clients connect to /mcp-tools/serve and
// authenticate with the x-floom-secret header (see apps/mcp/src/commands/mcp.ts
// resolveMcpConfig). This is the ready-to-paste mcpServers entry the CLI would
// otherwise write for you — here with the token embedded so it is copy-paste-ready.
function buildMcpJson(secret: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        workeros: {
          url: `${API_BASE}/mcp-tools/serve`,
          headers: { "x-floom-secret": secret },
        },
      },
    },
    null,
    2,
  );
}

// CLI subcommands surfaced for the CLI tab (mirror of apps/mcp/src/cli.ts). The
// curated MCP-tool catalog (McpToolCatalog) covers the MCP/agent surface; this
// is the human-facing `workeros <cmd>` list.
const CLI_COMMANDS: { name: string; description: string }[] = [
  { name: "workeros login", description: "Authenticate via browser device authorization." },
  { name: "workeros logout", description: "Remove saved CLI credentials." },
  { name: "workeros whoami", description: "Show the current auth identity." },
  { name: "workeros workers list", description: "List workers." },
  { name: "workeros workers show <id>", description: "Show one worker's config and metadata." },
  { name: "workeros workers info <id>", description: "Pretty single-worker summary (trigger, connections, last run)." },
  { name: "workeros workers push <dir>", description: "Create or update a worker from a local directory." },
  { name: "workeros workers validate <dir>", description: "Validate a local worker directory." },
  { name: "workeros run <id>", description: "Start and monitor a worker run." },
  { name: "workeros runs list", description: "List runs, filterable by worker or status." },
  { name: "workeros runs show <id>", description: "Show run details." },
  { name: "workeros runs logs <id>", description: "Show or follow run logs." },
  { name: "workeros runs download <id>", description: "Download a run's bundle archive." },
  { name: "workeros secrets list", description: "List secret names." },
  { name: "workeros secrets set <key>", description: "Set a secret value." },
  { name: "workeros secrets delete <key>", description: "Delete a secret." },
  { name: "workeros connections list", description: "List saved app and MCP connections." },
  { name: "workeros connections import-mcp-config <path>", description: "Import MCP servers from a client config JSON." },
  { name: "workeros mcp install --target <client>", description: "Install the Workeros MCP server into a client config." },
  { name: "workeros doctor", description: "Check CLI setup: API, auth, MCP, runs endpoint." },
];

// Representative API endpoints for the API tab. All take the x-floom-secret
// header shown above; this is a quick map, not the exhaustive surface.
const API_ENDPOINTS: { method: string; path: string; description: string }[] = [
  { method: "GET", path: "/workers?shape=list", description: "List workers (compact shape)." },
  { method: "GET", path: "/workers/{id}", description: "Read one worker." },
  { method: "POST", path: "/workers/{id}/runs", description: "Start a worker run." },
  { method: "GET", path: "/runs", description: "List runs, filterable by worker or status." },
  { method: "GET", path: "/runs/{id}", description: "Read a run with logs, outputs, and approval state." },
  { method: "GET", path: "/secrets", description: "List secret names and status." },
  { method: "GET", path: "/connections", description: "List app and MCP connections." },
  { method: "GET", path: "/system/overview", description: "Workspace dashboard: health, runs, approvals, alerts." },
];

export function CliCommandPanel() {
  const [copiedKey, setCopiedKey] = useState("");
  const [storedSecret, setStoredSecret] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [mcpTarget, setMcpTarget] = useState<McpTarget>("claude");
  const [generating, setGenerating] = useState(false);
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    // The generated OSS token is cached in this browser so setup snippets can
    // show the same credential the CLI receives from the device-flow endpoint.
    const stored = readStoredSecret();
    if (stored) setStoredSecret(stored);
  }, []);

  function storeSecret(value: string) {
    try {
      window.localStorage.setItem("floom_secret", value);
    } catch {}
    setStoredSecret(value);
  }

  async function generateToken() {
    setGenerating(true);
    setErrorText("");
    try {
      const startedResponse = await fetch(`${PROXY_BASE}/cli-auth/devices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "workers-settings", scopes: [] }),
      });
      const started = (await startedResponse.json().catch(() => ({}))) as {
        device_code?: string;
        user_code?: string;
        detail?: string;
      };
      if (!startedResponse.ok || !started.device_code || !started.user_code) {
        throw new Error(started.detail || "Could not start token generation");
      }

      const approvedResponse = await fetch(`${PROXY_BASE}/cli-auth/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: started.user_code }),
      });
      const approved = (await approvedResponse.json().catch(() => ({}))) as { detail?: string };
      if (!approvedResponse.ok) {
        throw new Error(approved.detail || "Could not approve token generation");
      }

      const polledResponse = await fetch(
        `${PROXY_BASE}/cli-auth/poll/${encodeURIComponent(started.device_code)}`
      );
      const polled = (await polledResponse.json().catch(() => ({}))) as {
        api_secret?: string;
        detail?: string;
      };
      if (!polledResponse.ok || !polled.api_secret) {
        throw new Error(polled.detail || "Generated token was not returned");
      }

      storeSecret(polled.api_secret);
      setRevealed(true);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Could not generate token");
    } finally {
      setGenerating(false);
    }
  }

  function clearSecret() {
    try {
      for (const key of SECRET_STORAGE_KEYS) window.localStorage.removeItem(key);
    } catch {}
    setStoredSecret("");
    setRevealed(false);
  }

  // The secret as shown in the UI (respects reveal state). When masked, falls
  // back to the bullet mask or a clear placeholder so nothing leaks.
  const displaySecret = revealed ? (storedSecret || "<your-token>") : (storedSecret ? maskSecret(storedSecret) : "<your-token>");
  // The secret as it should be COPIED — always the real token when one exists.
  const copySecret = storedSecret || "<your-token>";

  // W1: token-injected setup commands. Each surface has a `display` variant
  // (what the box renders — masked unless revealed) and a `copy` variant
  // (always the real token, since the user clicked Copy deliberately).
  const snippets = useMemo(() => {
    // P2-10 (audit 2026-05-29): the npm package @floomhq/workeros installs a
    // binary named `workeros` (see apps/mcp/package.json `bin`), NOT `floom`.
    // CLI auth: `workeros login` is the interactive browser device flow (no
    // token needed). To use THIS already-generated token non-interactively,
    // set WORKEROS_API_SECRET (see apps/mcp/src/lib/credentials.ts) and verify.
    const cli = (secret: string) =>
      `npm i -g @floomhq/workeros\nWORKEROS_API_SECRET=${secret} workeros whoami`;
    // MCP: ready-to-paste mcpServers JSON with the token embedded. The
    // `workeros mcp install` command would write the same thing after login.
    const mcp = (secret: string) => buildMcpJson(secret);
    const api = (secret: string) =>
      `curl -sS ${API_BASE}/workers?shape=list \\\n  -H "x-floom-secret: ${secret}"`;
    return {
      cli: { display: cli(displaySecret), copy: cli(copySecret) },
      mcp: { display: mcp(displaySecret), copy: mcp(copySecret) },
      api: { display: api(displaySecret), copy: api(copySecret) },
    };
  }, [displaySecret, copySecret]);

  async function copySnippet(key: "cli" | "mcp" | "api") {
    await navigator.clipboard.writeText(snippets[key].copy);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(""), 1200);
  }

  // The per-client install command for the MCP tab (writes config locally after
  // login). Copy always carries the same plain text.
  const mcpInstallCommand = buildMcpSnippet(mcpTarget);

  async function copyMcpInstall() {
    await navigator.clipboard.writeText(mcpInstallCommand);
    setCopiedKey("mcp-install");
    window.setTimeout(() => setCopiedKey(""), 1200);
  }

  async function copyTokenValue() {
    if (!storedSecret) return;
    await navigator.clipboard.writeText(storedSecret);
    setCopiedKey("token");
    window.setTimeout(() => setCopiedKey(""), 1200);
  }

  const activeMcpTarget = MCP_TARGETS.find((t) => t.value === mcpTarget)!;

  return (
    <div className="space-y-8">
      {/* S29s: dropped the Card wrapper. Was the only bordered block on a
          page of otherwise-flat sister tabs -- inconsistent. Now a flat
          section matching Setup commands below. */}
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-medium text-foreground">OSS API token</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Generate a browser copy of the single-user token for{" "}
            <code className="font-mono">workers-api.floom.dev</code>. Use it as{" "}
            <code className="font-mono">x-floom-secret</code>; Cloud PATs start
            with <code className="font-mono">floom_</code> and belong to{" "}
            <code className="font-mono">workeros-api.floom.dev</code>.
          </p>
        </div>
        {storedSecret ? (
          <div className="flex items-center gap-2 rounded-[var(--radius-card)] border border-line bg-[var(--bg-2)] px-3 py-2">
            <code className="flex-1 truncate font-mono text-xs">
              {revealed ? storedSecret : maskSecret(storedSecret)}
            </code>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? <EyeOff className="mr-1 h-3.5 w-3.5" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
              {revealed ? "Hide" : "Reveal"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void copyTokenValue()}
            >
              {copiedKey === "token" ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
              {copiedKey === "token" ? "Copied" : "Copy"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={generating}
              onClick={() => void generateToken()}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              {generating ? "Refreshing" : "Refresh"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={clearSecret}
            >
              Clear
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs"
              disabled={generating}
              onClick={() => void generateToken()}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              {generating ? "Generating" : "Generate token"}
            </Button>
          </div>
        )}
        {errorText && <p className="text-xs text-destructive">{errorText}</p>}
      </section>

      {/* W2: CLI / MCP / API are now real surfaces. Each tab swaps BOTH the
          setup snippet AND the reference list below it (CLI commands, MCP tool
          catalog, or API endpoints) — not just the code block. */}
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-medium text-foreground">Setup &amp; reference</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Install the CLI, add the MCP server, or hit the API directly. Commands embed your token
            {storedSecret ? (revealed ? "." : " (revealed above to see the real value).") : " once you generate one."}
          </p>
        </div>
        <Tabs defaultValue="cli">
          <TabsList>
            <TabsTrigger value="cli">CLI</TabsTrigger>
            <TabsTrigger value="mcp">MCP</TabsTrigger>
            <TabsTrigger value="api">API</TabsTrigger>
          </TabsList>

          {/* CLI surface */}
          <TabsContent value="cli" className="space-y-4">
            <SnippetBox
              text={snippets.cli.display}
              copied={copiedKey === "cli"}
              onCopy={() => void copySnippet("cli")}
            />
            <RefList
              title="CLI commands"
              filterPlaceholder="Filter commands..."
              items={CLI_COMMANDS.map((c) => ({ name: c.name, description: c.description }))}
            />
          </TabsContent>

          {/* MCP surface */}
          <TabsContent value="mcp" className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Paste this into your client&apos;s <code className="font-mono">mcpServers</code> config
              </p>
              <SnippetBox
                text={snippets.mcp.display}
                copied={copiedKey === "mcp"}
                onCopy={() => void copySnippet("mcp")}
              />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Or let the CLI write it for you
              </p>
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
              <SnippetBox
                text={mcpInstallCommand}
                copied={copiedKey === "mcp-install"}
                onCopy={() => void copyMcpInstall()}
              />
            </div>
            <McpToolCatalog />
          </TabsContent>

          {/* API surface */}
          <TabsContent value="api" className="space-y-4">
            <div className="space-y-1.5 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Base URL</span>
                <code className="font-mono text-xs text-foreground">{API_BASE}</code>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Auth header</span>
                <code className="font-mono text-xs text-foreground">x-floom-secret: {displaySecret}</code>
              </div>
            </div>
            <SnippetBox
              text={snippets.api.display}
              copied={copiedKey === "api"}
              onCopy={() => void copySnippet("api")}
            />
            <RefList
              title="Endpoints"
              filterPlaceholder="Filter endpoints..."
              items={API_ENDPOINTS.map((e) => ({
                name: `${e.method} ${e.path}`,
                description: e.description,
              }))}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// W3: a flat, filterable reference list used for the CLI-command and
// API-endpoint surfaces. Short lists (<= a screenful) so no collapsing needed,
// just a filter to cut scrolling. The longer MCP tool catalog uses collapsible
// groups instead (McpToolCatalog).
function RefList({
  title,
  filterPlaceholder,
  items,
}: {
  title: string;
  filterPlaceholder: string;
  items: { name: string; description: string }[];
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
    );
  }, [query, items]);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">
          {title}{" "}
          <span className="font-normal text-muted-foreground">({items.length})</span>
        </h3>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={filterPlaceholder}
          className="h-8 w-44 rounded-[var(--radius-input)] border border-line bg-[var(--bg-2)] px-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring"
        />
      </div>
      {filtered.length === 0 ? (
        <p className="px-1 py-3 text-xs text-muted-foreground">No matches.</p>
      ) : (
        <div className="divide-y divide-line rounded-[var(--radius-card)] border border-line overflow-hidden">
          {filtered.map((item) => (
            <div key={item.name} className="px-3 py-2.5">
              <code className="text-xs font-medium text-foreground">{item.name}</code>
              <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SnippetBox({
  text,
  copied,
  onCopy,
}: {
  text: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-line bg-[var(--bg-2)] dark:bg-[#1a1a1a]">
      <button
        type="button"
        onClick={onCopy}
        className="absolute right-2 top-2 z-10 inline-flex h-7 items-center gap-1 rounded-[var(--radius-button)] border border-line bg-card px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        aria-label={copied ? "Copied" : "Copy snippet"}
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
