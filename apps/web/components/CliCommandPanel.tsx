/* <!-- S15: drop <CliCommandPanel /> into the API access tab after S12 lands --> */
"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SECRET_STORAGE_KEYS = ["floom_secret", "FLOOM_SECRET", "workeros_api_secret"];
const API_BASE = "https://workers-api.floom.dev";

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
  if (!secret) return "<YOUR_FLOOM_SECRET>";
  if (secret.length <= 8) return "•".repeat(secret.length);
  return `${secret.slice(0, 4)}${"•".repeat(24)}${secret.slice(-4)}`;
}

function buildMcpSnippet(target: McpTarget): string {
  return `npx @floomhq/workeros install --target ${target}`;
}

export function CliCommandPanel() {
  const [copiedKey, setCopiedKey] = useState("");
  const [storedSecret, setStoredSecret] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [mcpTarget, setMcpTarget] = useState<McpTarget>("claude");

  useEffect(() => {
    // Security: the token lives only in this browser's localStorage. We do NOT
    // fetch it from the server. A prior /api/floom-secret route returned the
    // platform admin secret to ANY unauthenticated visitor (public credential
    // leak); it has been removed. The user pastes their token once below.
    const stored = readStoredSecret();
    if (stored) setStoredSecret(stored);
  }, []);

  function saveSecret() {
    const value = secretInput.trim();
    if (!value) return;
    try {
      window.localStorage.setItem("floom_secret", value);
    } catch {}
    setStoredSecret(value);
    setSecretInput("");
  }

  const apiSecret = revealed ? (storedSecret || "<YOUR_FLOOM_SECRET>") : maskSecret(storedSecret);

  const snippets = useMemo(
    () => ({
      cli: "npm i -g @floomhq/workeros\nfloom login",
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
          <h2 className="text-base font-medium text-foreground">Your Floom token</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Single-user v0: this token is the credential for every CLI / MCP /
            API call. Keep it private. Rotate from your env config on the API
            host if you ever paste it somewhere by accident.
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
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your FLOOM_SECRET to store it in this browser"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveSecret();
              }}
              className="flex-1 rounded-[var(--radius-button)] border border-line bg-[var(--bg-2)] px-3 py-2 font-mono text-xs outline-none"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-3 text-xs"
              disabled={!secretInput.trim()}
              onClick={saveSecret}
            >
              Save
            </Button>
          </div>
        )}
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
