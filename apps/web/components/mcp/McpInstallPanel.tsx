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
// token + generate flow are the shared oss-token helpers, so a token minted
// anywhere is reused everywhere.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, RefreshCw, ArrowRight } from "lucide-react";

import { buildMcpJson } from "@/lib/mcp-config";
import { getActiveWorkspaceId } from "@/lib/api";
import { getPublicApiHost } from "@/lib/api-base";
import { generateOssToken, readStoredSecret } from "@/lib/oss-token";

const MCP_CLIENTS = [
  { label: "Claude", mark: "C" },
  { label: "Cursor", mark: ">" },
  { label: "Codex", mark: "CX" },
  { label: "VS Code", mark: "{}" },
  { label: "Windsurf", mark: "W" },
  { label: "Cline", mark: "CL" },
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
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium text-foreground">Agent install</h2>
        <p className="text-xs text-muted-foreground">
          Copy this into Claude Desktop, Cursor, VS Code, Windsurf, Cline, or any
          MCP client. {hasToken
            ? "Your key is already included."
            : "Create a key below to include it."}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Supported MCP clients">
        {MCP_CLIENTS.map((client) => (
          <div
            key={client.label}
            className="flex h-10 items-center gap-2 rounded-[var(--radius-ui)] bg-[var(--bg-2)] px-2.5 text-[12px] text-[var(--ink-soft)]"
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-ui)] bg-[var(--bg-card)] font-mono text-[10px] font-semibold text-[var(--ink)] shadow-[0_0_0_1px_var(--border-soft)]">
              {client.mark}
            </span>
            <span className="truncate font-medium">{client.label}</span>
          </div>
        ))}
      </div>

      {/* code block + copy */}
      <div className="relative">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="absolute right-2.5 top-2.5 z-10 inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--bg-card)] px-2.5 text-[12px] font-medium text-[var(--ink-soft)] shadow-[0_1px_2px_hsl(0_0%_0%/.06),0_0_0_1px_var(--border-soft)] transition-colors hover:text-ink"
          aria-label={copied ? "Copied" : "Copy config"}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <pre className="overflow-x-auto rounded-[var(--radius-button)] bg-[var(--bg-2)] px-4 py-4 pr-20 font-mono text-[12.5px] leading-[1.7] text-[var(--ink-soft)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <code>{snippet}</code>
        </pre>
      </div>

      {/* token state */}
      {!hasToken && (
        <div className="flex items-center gap-2.5 rounded-[var(--radius-button)] bg-[var(--bg-2)] px-3 py-2.5">
          <p className="flex-1 text-[12px] leading-snug text-[var(--ink-mute)]">
            No key in this browser yet. Create one to include it in the config above.
          </p>
          <button
            type="button"
            onClick={() => void generateToken()}
            disabled={generating}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--primary)] px-3 text-[12px] font-medium text-[var(--primary-text)] transition-opacity hover:opacity-90 disabled:opacity-50"
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
        rotate it anytime in Settings → Connect &amp; automate.
      </p>

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
