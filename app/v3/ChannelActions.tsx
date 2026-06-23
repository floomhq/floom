"use client";

import { useState } from "react";
import { Check, Copy, Terminal, X } from "lucide-react";
import { ClaudeLogo, CodexLogo, CursorLogo } from "@/components/landing-icons";

const MCP_CLIENTS: { name: string; logo: React.ReactNode }[] = [
  { name: "Claude Code", logo: <ClaudeLogo /> },
  { name: "Codex", logo: <CodexLogo /> },
  { name: "Cursor", logo: <CursorLogo /> },
];

type Channel = "mcp";
type Modal = "mcp" | null;

const MCP_CONFIG = `{
  "mcpServers": {
    "floom": {
      "command": "npx",
      "args": ["-y", "@floomhq/floom", "mcp"]
    }
  }
}`;

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/28 px-4 py-8 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[420px] rounded-[20px] bg-[var(--bg-app)] p-5 text-left"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[18px] font-semibold tracking-[-0.018em]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-secondary text-muted-foreground transition-colors hover:bg-[var(--bg-3)] hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* The MCP config popover content, reused by the header MCP affordance and any
   other caller. Self-contained: own open/close state. */
export function McpConfigModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <ModalShell title="Use Floom from an MCP agent" onClose={onClose}>
      <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
        Add this server block to Claude Code, Cursor, Codex, or any MCP client. Floom asks for a workspace token the first time it runs.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {MCP_CLIENTS.map((c) => (
          <span
            key={c.name}
            className="inline-flex items-center gap-1.5 rounded-[10px] bg-secondary px-2.5 py-1.5 text-[12px] font-medium text-foreground"
          >
            <span className="flex h-3.5 w-3.5 items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5">
              {c.logo}
            </span>
            {c.name}
          </span>
        ))}
      </div>
      <pre className="mt-4 overflow-x-auto rounded-[14px] bg-secondary p-4 font-mono text-[11.5px] leading-relaxed text-foreground/85">
        {MCP_CONFIG}
      </pre>
      <McpCopyButton />
    </ModalShell>
  );
}

/* Small header affordance: an "MCP" button that opens the config popover.
   Lives in the V3Shell nav (top-right), left of theme + Sign in. */
export function McpHeaderButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="MCP config"
        title="MCP config"
        className="inline-flex h-8 items-center gap-1.5 rounded-[10px] px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <Terminal className="h-3.5 w-3.5" />
        MCP
      </button>
      <McpConfigModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function McpCopyButton() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard?.writeText(MCP_CONFIG);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
      className="mt-3 inline-flex h-9 items-center gap-2 rounded-[10px] bg-foreground px-3.5 text-[12.5px] font-medium text-background"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy config"}
    </button>
  );
}

export function ChannelActions({ compact = false, only }: { compact?: boolean; only?: Channel }) {
  const [modal, setModal] = useState<Modal>(null);
  // On the landing hero the MCP affordance now lives in the top-right header
  // (McpHeaderButton), so the default (no `only`) ChannelActions row renders
  // nothing. The explicit MCP caller (/start/mcp) passes `only="mcp"` to surface
  // the install CTA. Slack/WhatsApp channels were removed (never shipped).
  const showMcp = only === "mcp";

  // Nothing to render in the default landing case: hide the row entirely.
  if (!showMcp) return null;

  return (
    <>
      <span className={`inline-flex flex-wrap items-center justify-center gap-2 ${compact ? "" : "mt-4"}`}>
        <button
          type="button"
          onClick={() => setModal("mcp")}
          className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-secondary px-3.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-[var(--bg-3)]"
        >
          <Terminal className="h-3.5 w-3.5" />
          MCP config
        </button>
      </span>

      {modal === "mcp" ? <McpConfigModal open onClose={() => setModal(null)} /> : null}
    </>
  );
}
