"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, Copy, MessageCircle, Slack, Terminal, X } from "lucide-react";

type Channel = "slack" | "whatsapp" | "mcp";
type Modal = Exclude<Channel, "slack"> | null;

const MCP_CONFIG = `{
  "mcpServers": {
    "floom": {
      "command": "npx",
      "args": ["-y", "@floomhq/workeros", "mcp"]
    }
  }
}`;

function QrMark() {
  const cells = useMemo(
    () =>
      Array.from({ length: 49 }, (_, i) => {
        const x = i % 7;
        const y = Math.floor(i / 7);
        const finder =
          (x < 2 && y < 2) ||
          (x > 4 && y < 2) ||
          (x < 2 && y > 4);
        const data = [10, 12, 17, 19, 23, 25, 30, 33, 37, 40, 45].includes(i);
        return finder || data;
      }),
    [],
  );
  return (
    <div aria-hidden className="grid h-36 w-36 grid-cols-7 gap-1 rounded-[18px] bg-card p-4">
      {cells.map((on, i) => (
        <span key={i} className={`rounded-[3px] ${on ? "bg-foreground" : "bg-secondary"}`} />
      ))}
    </div>
  );
}

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
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/28 px-4 py-8 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-[420px] rounded-[20px] bg-[var(--bg-app)] p-5 text-left">
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
  const showSlack = !only || only === "slack";
  const showWhatsApp = !only || only === "whatsapp";
  const showMcp = !only || only === "mcp";

  return (
    <>
      <span className={`inline-flex flex-wrap items-center justify-center gap-2 ${compact ? "" : "mt-4"}`}>
        {showSlack ? (
          <Link
            href="/login?install=slack"
            className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-secondary px-3.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-[var(--bg-3)]"
          >
            <Slack className="h-3.5 w-3.5" />
            Add to Slack
          </Link>
        ) : null}
        {showWhatsApp ? (
          <button
            type="button"
            onClick={() => setModal("whatsapp")}
            className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-secondary px-3.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-[var(--bg-3)]"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            WhatsApp QR
          </button>
        ) : null}
        {showMcp ? (
          <button
            type="button"
            onClick={() => setModal("mcp")}
            className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-secondary px-3.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-[var(--bg-3)]"
          >
            <Terminal className="h-3.5 w-3.5" />
            MCP config
          </button>
        ) : null}
      </span>

      {modal === "whatsapp" ? (
        <ModalShell title="Connect WhatsApp" onClose={() => setModal(null)}>
          <div className="mt-5 flex flex-col items-center gap-4">
            <QrMark />
            <p className="max-w-[300px] text-center text-[13px] leading-relaxed text-muted-foreground">
              Scan to start the WhatsApp pairing flow. Sign in appears only when the number is ready to bind to your workspace.
            </p>
            <Link
              href="/login?install=whatsapp"
              className="inline-flex h-10 items-center rounded-[10px] px-4 text-[13px] font-medium text-white"
              style={{ background: "var(--v3-accent)" }}
            >
              Open pairing flow
            </Link>
          </div>
        </ModalShell>
      ) : null}

      {modal === "mcp" ? (
        <ModalShell title="Use Floom from an MCP agent" onClose={() => setModal(null)}>
          <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
            Add this server block to Claude Code, Cursor, Codex, or any MCP client. Floom asks for a workspace token the first time it runs.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-[14px] bg-secondary p-4 font-mono text-[11.5px] leading-relaxed text-foreground/85">
            {MCP_CONFIG}
          </pre>
          <McpCopyButton />
        </ModalShell>
      ) : null}
    </>
  );
}
