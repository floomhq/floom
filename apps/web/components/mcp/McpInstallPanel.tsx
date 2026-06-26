"use client";

// SHARED MCP-install panel — "Add Floom to your AI client". Rendered in BOTH the
// sidebar "MCP" popup (McpInstallModal wraps this in dialog chrome) and Settings
// → Connect & automate → MCP setup.
//
// One clean, token-free npx snippet (from buildMcpJson): the `@floomhq/floom`
// CLI runs the MCP server over stdio and does its own device-auth login on first
// run (cloud or OSS), so the config carries no URL, workspace id, or secret —
// nothing to generate, rotate, or paste by hand.
import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";

import { BrandLogo } from "@/components/connections/BrandLogo";
import { buildMcpJson } from "@/lib/mcp-config";

const MCP_CLIENTS = [
  { label: "Claude Code", icon: "claude-code" },
  { label: "Cursor", icon: "cursor" },
  { label: "Codex", icon: "codex" },
  { label: "VS Code", icon: "vscode" },
  { label: "Windsurf", icon: "windsurf" },
  { label: "Cline", icon: "cline" },
];

const SNIPPET = buildMcpJson();

export function McpInstallPanel() {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(SNIPPET);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — non-fatal */
    }
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">MCP setup</h2>
        <p className="mt-3 max-w-[58ch] text-sm leading-6 text-muted-foreground">
          Copy this into Claude Code, Cursor, Codex, VS Code, Windsurf, Cline, or
          any MCP client. Floom asks for a workspace token the first time it runs.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label="Supported MCP clients">
        {MCP_CLIENTS.map((client) => (
          <span
            key={client.label}
            title={client.label}
            className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-button)] bg-[var(--bg-2)] px-3 text-sm font-medium text-[var(--ink-soft)]"
          >
            <BrandLogo icon={client.icon} className="size-4 shrink-0" />
            <span>{client.label}</span>
          </span>
        ))}
      </div>

      {/* code block + copy */}
      <div className="min-w-0 overflow-hidden rounded-[var(--radius-card)] bg-[#0D0F12] shadow-[inset_0_1px_0_rgba(255,255,255,.04)]">
        <pre className="max-w-full overflow-x-auto p-5 font-mono text-[13px] leading-7 text-[#E8EAED] [scrollbar-width:thin]">
          <code>{SNIPPET}</code>
        </pre>
      </div>

      <button
        type="button"
        onClick={() => void handleCopy()}
        className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-button)] bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90"
        aria-label={copied ? "Copied config" : "Copy config"}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied ? "Copied" : "Copy config"}
      </button>
    </div>
  );
}
