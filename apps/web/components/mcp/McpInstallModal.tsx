"use client";

// MCP install POPUP modal — "Add Floom to your AI client".
//
// Opened from the sidebar "MCP" item (NOT a page). Claude / Cursor / VS Code
// tabs, a copy-able config with the user's REAL token baked in, Copy button,
// closes on X / backdrop / Esc.
//
// Token source is the SAME single-user OSS API secret the Settings → API tab
// uses (sessionStorage, minted via the CLI device-auth flow). We never
// hard-code or hallucinate a token: if none is stored yet, the user can mint
// one in-place ("Generate token"), mirroring CliCommandPanel. The ready-to-paste
// config is produced by buildMcpServerConfig() so the URL + headers match the
// real MCP transport (x-floom-secret + the pinned workspace).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, RefreshCw, X } from "lucide-react";

import { buildMcpServerConfig } from "@/lib/mcp-config";
import { getActiveWorkspaceId } from "@/lib/api";
import { getPublicApiHost } from "@/lib/api-base";
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "@/lib/safe-storage";

// Mirror of CliCommandPanel's storage contract so a token minted in either
// place is shared (single source of truth for the OSS secret).
const SECRET_SESSION_KEY = "workeros_api_secret";
const SECRET_LEGACY_LS_KEYS = ["floom_secret", "FLOOM_SECRET", "workeros_api_secret"];

function readStoredSecret(): string {
  for (const key of SECRET_LEGACY_LS_KEYS) {
    const ls = safeStorageGet("local", key);
    if (ls && ls.trim()) {
      safeStorageSet("session", SECRET_SESSION_KEY, ls.trim());
      safeStorageRemove("local", key);
      return ls.trim();
    }
  }
  return safeStorageGet("session", SECRET_SESSION_KEY)?.trim() ?? "";
}

type Client = "claude" | "cursor" | "vscode";

const CLIENT_TABS: { value: Client; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "cursor", label: "Cursor" },
  { value: "vscode", label: "VS Code" },
];

// Build the per-client snippet from the REAL config. Claude/Cursor take the
// mcpServers JSON; VS Code uses its `code --add-mcp` one-liner with the same
// url + header.
function buildSnippet(client: Client, secret: string, workspaceId: string | null): string {
  const cfg = buildMcpServerConfig(secret, workspaceId);
  if (client === "vscode") {
    const server = {
      name: "floom",
      ...cfg.mcpServers.workeros,
    };
    return `code --add-mcp '${JSON.stringify(server)}'`;
  }
  return JSON.stringify(cfg, null, 2);
}

export function McpInstallModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [client, setClient] = useState<Client>("claude");
  const [secret, setSecret] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  // Read the stored token + active workspace when the modal opens.
  useEffect(() => {
    if (!open) return;
    setSecret(readStoredSecret());
    setWorkspaceId(getActiveWorkspaceId());
    setError("");
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const hasToken = secret.length > 0;

  // The snippet always renders the REAL config shape. When no token is stored
  // yet, the placeholder is an honest <YOUR_TOKEN> so nothing is faked.
  const snippet = useMemo(
    () => buildSnippet(client, hasToken ? secret : "<YOUR_TOKEN>", workspaceId),
    [client, hasToken, secret, workspaceId],
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

  // Mint an OSS token in-place via the CLI device-auth flow (same path as
  // CliCommandPanel.generateToken). Keeps the modal self-sufficient so the user
  // doesn't have to detour to Settings.
  const generateToken = useCallback(async () => {
    setGenerating(true);
    setError("");
    const PROXY_BASE = "/api/proxy";
    try {
      const startedResponse = await fetch(`${PROXY_BASE}/cli-auth/devices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "mcp-modal", scopes: [] }),
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
        `${PROXY_BASE}/cli-auth/poll/${encodeURIComponent(started.device_code)}`,
      );
      const polled = (await polledResponse.json().catch(() => ({}))) as {
        api_secret?: string;
        detail?: string;
      };
      if (!polledResponse.ok || !polled.api_secret) {
        throw new Error(polled.detail || "Generated token was not returned");
      }
      try {
        safeStorageSet("session", SECRET_SESSION_KEY, polled.api_secret);
      } catch {}
      setSecret(polled.api_secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate token");
    } finally {
      setGenerating(false);
    }
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Add Floom to your AI client"
    >
      {/* backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-[rgba(16,17,20,.32)] dark:bg-black/55"
      />
      {/* dialog */}
      <div className="relative z-[1] w-full max-w-[540px] rounded-[var(--radius-card)] bg-[var(--bg-card)] dark:bg-[var(--bg-2)] p-6 shadow-[var(--shadow-pop)]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3.5 top-3.5 inline-flex size-7 items-center justify-center rounded-[var(--radius-button)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-2)] hover:text-ink"
        >
          <X className="size-4" />
        </button>

        <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">
          Add Floom to your AI client
        </h2>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--text-muted)]">
          Use your Floom workers as tools in Claude, Cursor, or VS Code. Paste this —
          your token&apos;s already in it.
        </p>

        {/* client tabs */}
        <div className="mt-5 inline-flex w-fit gap-0.5 rounded-[var(--radius-button)] bg-[var(--bg-2)] p-0.5">
          {CLIENT_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setClient(tab.value)}
              className={
                "rounded-[calc(var(--radius-button)-2px)] px-3.5 py-1.5 text-[12.5px] font-medium transition-colors " +
                (client === tab.value
                  ? "bg-[var(--bg-card)] text-ink shadow-[0_1px_2px_hsl(0_0%_0%/.07)]"
                  : "text-[var(--ink-mute)] hover:text-ink")
              }
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* code block + copy */}
        <div className="relative mt-3">
          <button
            type="button"
            onClick={handleCopy}
            className="absolute right-2.5 top-2.5 inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--bg-card)] px-2.5 text-[12px] font-medium text-[var(--ink-soft)] shadow-[0_1px_2px_hsl(0_0%_0%/.06),0_0_0_1px_var(--border-soft)] transition-colors hover:text-ink"
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
          <div className="mt-3 flex items-center gap-2.5 rounded-[var(--radius-button)] bg-[var(--bg-2)] px-3 py-2.5">
            <p className="flex-1 text-[12px] leading-snug text-[var(--ink-mute)]">
              No token in this browser yet — generate one to bake it into the config above.
            </p>
            <button
              type="button"
              onClick={() => void generateToken()}
              disabled={generating}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--primary)] px-3 text-[12px] font-medium text-[var(--primary-text)] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <RefreshCw className={"size-3 " + (generating ? "animate-spin" : "")} />
              {generating ? "Generating" : "Generate token"}
            </button>
          </div>
        )}

        {error && <p className="mt-2 text-[12px] text-[var(--warning)]">{error}</p>}

        <p className="mt-3.5 text-[12px] leading-relaxed text-[var(--ink-mute)]">
          Drop it into your client&apos;s MCP config and your workers show up as tools.
          The token scopes to{" "}
          <code className="font-mono text-[11.5px]">{getPublicApiHost()}</code>;
          rotate it anytime in Settings → API.
        </p>
      </div>
    </div>
  );
}
