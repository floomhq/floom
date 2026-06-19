"use client";

// MCP install POPUP modal, "Add Floom to your AI client".
//
// Opened from the sidebar "MCP" item (NOT a page). This is now ONLY the dialog
// chrome (backdrop, panel, close affordances) around the SHARED <McpInstallPanel/>
// — the exact same install treatment the Settings → Connect & automate → MCP
// section renders. Single source of truth: same snippet, same client list, same
// real-token flow. (Federico: "mcp on left sidebar, why not simply same as mcp
// says on settings?")
import { useEffect } from "react";
import { X } from "lucide-react";

import { McpInstallPanel } from "./McpInstallPanel";

export function McpInstallModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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

        <McpInstallPanel />
      </div>
    </div>
  );
}
