"use client";

// SHARED MCP-install panel — the single source of truth for "Add Floom to your
// AI client". Rendered in BOTH places that install the MCP server:
//   1. the sidebar "MCP" popup (McpInstallModal wraps this in dialog chrome), and
//   2. Settings → Connect & automate → MCP ("Agent install").
//
// Before this, the two surfaces were different treatments: the popup had 3
// Claude/Cursor/VS-Code tabs with a real token baked in, while Settings showed a
// STATIC `npx`-based snippet with NO token. Federico: "mcp on left sidebar, why
// not simply same as mcp says on settings?" — so this is ONE component, using
// the SETTINGS wording (Claude Desktop, Cursor, VS Code, Windsurf, Cline, or any
// MCP client) and the REAL token flow.
//
// The snippet is the ready-to-paste `mcpServers` config from buildMcpJson(),
// with the user's real OSS secret embedded (+ the active workspace pinned). The
// token + generate flow are the shared oss-token helpers (same path the
// CliCommandPanel uses), so a token minted anywhere is reused everywhere.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, RefreshCw, ArrowRight, KeyRound } from "lucide-react";

import { BrandLogo } from "@/components/connections/BrandLogo";
import { buildMcpJson } from "@/lib/mcp-config";
import { getActiveWorkspaceId } from "@/lib/api";
import { getPublicApiHost } from "@/lib/api-base";
import { generateOssToken, readStoredSecret } from "@/lib/oss-token";

const MCP_CLIENTS = [
  { label: "Claude Code", icon: "claude-code" },
  { label: "Cursor", icon: "cursor" },
  { label: "Codex", icon: "codex" },
  { label: "VS Code", icon: "vscode" },
  { label: "Windsurf", icon: "windsurf" },
  { label: "Cline", icon: "cline" },
];

export function McpInstallPanel() {
  const [secret, setSecret] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  // Read the cached token + active workspace on mount.
  useEffect(() => {
    setSecret(readStoredSecret());
    setWorkspaceId(getActiveWorkspaceId());
  }, []);

  const hasToken = secret.length > 0;

  // The snippet always renders the REAL config shape. When no token is cached
  // yet, the placeholder is an honest <YOUR_TOKEN> so nothing is faked — and the
  // "Generate token" CTA below mints one in-place and bakes it in.
  const snippet = useMemo(
    () => buildMcpJson(hasToken ? secret : "<YOUR_TOKEN>", workspaceId),
    [hasToken, secret, workspaceId],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setError("Could not copy to clipboard.");
    }
  }, [snippet]);

  const generateToken = useCallback(async () => {
    setGenerating(true);
    setError("");
    try {
      const token = await generateOssToken("mcp-install");
      setSecret(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate token");
    } finally {
      setGenerating(false);
    }
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Agent install</h2>
        <p className="mt-3 max-w-[58ch] text-sm leading-6 text-muted-foreground">
          Copy this into Claude Code, Cursor, Codex, VS Code, Windsurf, Cline, or any
          MCP client. {hasToken
            ? "Your key is already included."
            : "Create a key below to include it."}
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
      <div className="min-w-0 overflow-hidden rounded-[var(--radius-card)] bg-[var(--bg-2)]">
        <pre className="max-w-full overflow-x-auto p-5 font-mono text-[13px] leading-7 text-[var(--ink-soft)] [scrollbar-width:thin]">
          <code>{snippet}</code>
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

      {/* token state */}
      {!hasToken && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-[12px] leading-snug text-[var(--ink-mute)]">
            No key in this browser yet. Create one to include it in the config above.
          </p>
          <button
            type="button"
            onClick={() => void generateToken()}
            disabled={generating}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ink-soft)] transition-colors hover:text-ink disabled:opacity-50"
          >
            <RefreshCw className={"size-3 " + (generating ? "animate-spin" : "")} />
            {generating ? "Generating" : "Create key"}
          </button>
        </div>
      )}

      {error && <p className="text-[12px] text-[var(--warning)]">{error}</p>}

      <p className="text-[12px] leading-relaxed text-[var(--ink-mute)]">
        Drop it into your client&apos;s MCP config and your workers show up as tools.
        The key scopes to{" "}
        <code className="font-mono text-[11.5px]">{getPublicApiHost()}</code>;
        rotate it anytime in Settings → Personal access tokens.
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href="/settings?sel=personal_tokens"
          className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--ink-soft)] transition-colors hover:text-ink"
        >
          <KeyRound className="size-3" />
          Manage personal tokens
        </Link>
        <Link
          href="/settings?sel=connect&tab=mcp"
          className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--ink-soft)] transition-colors hover:text-ink"
        >
          Agent install settings
          <ArrowRight className="size-3" />
        </Link>
      </div>

      {/* Round-09 batch2: with the in-page Connections tab row gone, the full
          MCP page (register MCP servers your workers call) is reached from here
          — the popup is the canonical MCP entry, no duplicate sidebar nav. */}
      <Link
        href="/connections/mcp"
        className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--ink-soft)] transition-colors hover:text-ink"
      >
        Manage MCP servers
        <ArrowRight className="size-3" />
      </Link>
    </div>
  );
}
