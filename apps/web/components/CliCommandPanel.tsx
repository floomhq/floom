/* <!-- S15: drop <CliCommandPanel /> into the API access tab after S12 lands --> */
"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SECRET_STORAGE_KEYS = ["floom_secret", "FLOOM_SECRET", "workeros_api_secret"];
const API_BASE = "https://workers-api.floom.dev";

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

export function CliCommandPanel() {
  const [copiedKey, setCopiedKey] = useState("");
  const [storedSecret, setStoredSecret] = useState("");
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const stored = readStoredSecret();
    if (stored) {
      setStoredSecret(stored);
      return;
    }
    // PR S19 (I-4): fall back to the server-side env var so the user
    // doesn't have to hand-paste the token into localStorage before
    // they can see it on Settings -> API access.
    fetch("/api/floom-secret")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.api_secret) {
          setStoredSecret(d.api_secret);
          try {
            window.localStorage.setItem("floom_secret", d.api_secret);
          } catch {}
        }
      })
      .catch(() => {});
  }, []);

  const apiSecret = revealed ? (storedSecret || "<YOUR_FLOOM_SECRET>") : maskSecret(storedSecret);

  const snippets = useMemo(
    () => ({
      cli: "npm i -g @floomhq/workeros\nfloom login",
      mcp: "npx @floomhq/workeros install --target claude",
      api: `curl -sS ${API_BASE}/workers \\\n  -H "x-floom-secret: ${apiSecret}"`,
    }),
    [apiSecret]
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
        <div className="flex items-center gap-2 border border-line bg-[var(--bg-2)] px-3 py-2">
          <code className="flex-1 truncate font-mono text-xs">
            {revealed ? (storedSecret || "<not configured>") : maskSecret(storedSecret)}
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
            disabled={!storedSecret}
            onClick={() => void copyTokenValue()}
          >
            {copiedKey === "token" ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
            {copiedKey === "token" ? "Copied" : "Copy"}
          </Button>
        </div>
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
          <TabsContent value="mcp">
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
