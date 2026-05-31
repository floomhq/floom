/* <!-- S15: drop <CliCommandPanel /> into the API access tab after S12 lands --> */
"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SECRET_STORAGE_KEYS = ["floom_secret", "FLOOM_SECRET", "workeros_api_secret"];
const API_BASE = "https://workers-api.floom.dev";
const PROXY_BASE = "/api/proxy";

type McpTarget = "claude" | "cursor" | "vscode" | "windsurf" | "generic";

const MCP_TARGETS: { value: McpTarget; label: string; hint: string }[] = [
  { value: "claude",   label: "Claude",   hint: "~/.claude/settings.json" },
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
  return `npx @floomhq/workeros install --target ${target}`;
}

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

  const apiSecret = revealed ? (storedSecret || "<YOUR_OSS_FLOOM_SECRET>") : maskSecret(storedSecret);

  const snippets = useMemo(
    () => ({
      // P2-10 (audit 2026-05-29): the npm package @floomhq/workeros installs a
      // binary named `workeros` (see apps/mcp/package.json `bin`), NOT `floom`.
      // Showing `floom login` here had the user run a command that does not
      // exist after install. Use the real installed binary name.
      cli: "npm i -g @floomhq/workeros\nworkeros login",
      mcp: buildMcpSnippet(mcpTarget),
      api: `curl -sS ${API_BASE}/workers \\\n  -H "x-floom-secret: ${apiSecret}"`,
    }),
    [apiSecret, mcpTarget]
  );

  async function copySnippet(key: "cli" | "mcp" | "api") {
    await navigator.clipboard.writeText(snippets[key]);
    setCopiedKey(key);
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
          <div className="flex items-center gap-2 rounded-[var(--radius-button)] border border-line bg-[var(--bg-2)] px-3 py-2">
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

      {/* S29f (F8.2): was a nested Card with floating Copy button + small
          uneven tabs + accidental glow border. Now flat under a clear H2,
          single ring border on the code block, Copy button overlays the
          top-right corner of the <pre> so the eye lands on the same spot
          for every tab. */}
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
            <SnippetBox
              text={snippets.cli}
              copied={copiedKey === "cli"}
              onCopy={() => void copySnippet("cli")}
            />
          </TabsContent>
          <TabsContent value="mcp" className="space-y-2">
            {/* Target picker — small inline segmented control */}
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
            <SnippetBox
              text={snippets.mcp}
              copied={copiedKey === "mcp"}
              onCopy={() => void copySnippet("mcp")}
            />
          </TabsContent>
          <TabsContent value="api">
            <SnippetBox
              text={snippets.api}
              copied={copiedKey === "api"}
              onCopy={() => void copySnippet("api")}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
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
    <div className="relative rounded-[var(--radius-button)] border border-line bg-[var(--bg-2)] dark:bg-[#1a1a1a]">
      <button
        type="button"
        onClick={onCopy}
        className="absolute right-2 top-2 inline-flex h-7 items-center gap-1 rounded-[var(--radius-button)] border border-line bg-card px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
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
