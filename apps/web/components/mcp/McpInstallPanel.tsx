"use client";

// SHARED MCP-install panel — "Agent install". Rendered in BOTH the sidebar "MCP"
// popup (McpInstallModal wraps this in dialog chrome) and Settings → Connect &
// automate → MCP setup.
//
// One clean, token-free npx snippet (from buildMcpJson): the `@floomhq/floom`
// CLI runs the MCP server over stdio and does its own device-auth login on first
// run (cloud or OSS), so the config carries no URL, workspace id, or secret —
// nothing to generate, rotate, or paste by hand.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { BrandLogo } from "@/components/connections/BrandLogo";
import { api } from "@/lib/api";
import { buildMcpJson } from "@/lib/mcp-config";
import type { WorkspaceToken } from "@/lib/types";

const MCP_CLIENTS = [
  { label: "Claude Code", icon: "claude-code" },
  { label: "Codex", icon: "codex" },
  { label: "Cursor", icon: "cursor" },
];

const SNIPPET = buildMcpJson();

export function McpInstallPanel() {
  const [copied, setCopied] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokens, setTokens] = useState<WorkspaceToken[] | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [creatingToken, setCreatingToken] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.workspace.tokens
      .list()
      .then((rows) => {
        if (!alive) return;
        setTokens(rows);
        setTokenError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setTokens([]);
        setTokenError(err instanceof Error ? err.message : "Could not load workspace tokens.");
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(SNIPPET);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — non-fatal */
    }
  }, []);

  const handleCreateToken = useCallback(async () => {
    if (creatingToken) return;
    setCreatingToken(true);
    setCreatedToken(null);
    setTokenCopied(false);
    try {
      const result = await api.workspace.tokens.create("MCP agent install");
      setCreatedToken(result.token);
      const rows = await api.workspace.tokens.list();
      setTokens(rows);
      setTokenError(null);
      toast.success("Workspace token created");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not create workspace token.";
      setTokenError(message);
      toast.error(message);
    } finally {
      setCreatingToken(false);
    }
  }, [creatingToken]);

  const handleCopyToken = useCallback(async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setTokenCopied(true);
      window.setTimeout(() => setTokenCopied(false), 1200);
      toast.success("Workspace token copied");
    } catch {
      toast.error("Could not copy token");
    }
  }, [createdToken]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Agent install</h2>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          Copy this into Claude Code, Cursor, Codex, VS Code, Windsurf, Cline, or
          any MCP client. Create a workspace token here, then paste it when Floom
          asks on first run.
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
      <div className="min-w-0 overflow-hidden rounded-[var(--radius-button)] bg-[var(--bg-2)] [border:var(--bd-div)]">
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

      <div className="rounded-[var(--radius-button)] [border:var(--bd-div)] bg-[var(--bg-card)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
              <KeyRound className="size-3.5 text-[var(--ink-mute)]" />
              Workspace token
            </div>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
              Token values are shown once. Existing tokens: {tokens === null ? "loading" : tokens.length}.
            </p>
          </div>
          <Link
            href="/settings?sel=developer"
            className="text-[12px] font-medium text-[var(--accent)] hover:underline"
          >
            Manage tokens
          </Link>
        </div>

        {createdToken ? (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2 rounded-[var(--radius-button)] bg-[var(--bg-2)] px-3 py-2 font-mono text-[12px]">
              <span className="min-w-0 flex-1 break-all">{createdToken}</span>
              <button
                type="button"
                onClick={() => void handleCopyToken()}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-button)] px-2 text-[12px] font-medium text-[var(--ink-soft)] hover:bg-[var(--bg-1)] hover:text-foreground"
                aria-label={tokenCopied ? "Copied token" : "Copy token"}
              >
                {tokenCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {tokenCopied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">This value will not be shown again.</p>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleCreateToken()}
              disabled={creatingToken}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] [border:var(--bd-card)] px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-[var(--active-nav-bg)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {creatingToken ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
              {creatingToken ? "Creating" : "Create token"}
            </button>
            {tokenError ? (
              <span className="text-[12px] text-muted-foreground">
                Could not create here. Open Manage tokens.
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
