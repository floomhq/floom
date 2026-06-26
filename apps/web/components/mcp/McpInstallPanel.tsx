"use client";

// SHARED MCP-install panel — "Agent install". Rendered in BOTH the sidebar "MCP"
// popup (McpInstallModal wraps this in dialog chrome) and Settings → Connect &
// automate → MCP setup.
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
  { label: "Codex", icon: "codex" },
  { label: "Cursor", icon: "cursor" },
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
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Agent install</h2>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          Copy this into Claude Code, Cursor, Codex, VS Code, Windsurf, Cline, or
          any MCP client. Floom asks for a workspace token the first time it runs.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" aria-label="Supported MCP clients">
        {MCP_CLIENTS.map((client) => (
          <span
            key={client.label}
            title={client.label}
            className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--bg-2)] px-2.5 text-[12px] font-medium text-[var(--ink-soft)]"
          >
            <BrandLogo icon={client.icon} className="size-3.5 shrink-0" />
            <span>{client.label}</span>
          </span>
        ))}
      </div>

      {/* light code block (matches the Agent-install card) */}
      <div className="min-w-0 overflow-hidden rounded-[var(--radius-button)] bg-[var(--bg-2)] ring-1 ring-inset ring-[var(--bd-div)]">
        <pre className="max-w-full overflow-x-auto p-4 font-mono text-[12px] leading-6 text-foreground [scrollbar-width:thin]">
          <code>{SNIPPET}</code>
        </pre>
      </div>

      <button
        type="button"
        onClick={() => void handleCopy()}
        className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-button)] bg-foreground px-3.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
        aria-label={copied ? "Copied config" : "Copy config"}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy config"}
      </button>
    </div>
  );
}
