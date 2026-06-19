"use client";

// Global MCP-install modal context.
//
// The "MCP" sidebar item and the home's "Find an MCP server" / "See what Emily
// can connect" affordances all open the SAME popup modal. Mounting the modal
// once at the AppShell level (over everything) and exposing open/close via
// context keeps it a true overlay — not a per-page mount — and avoids
// prop-drilling the opener through the sidebar + home.
import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { McpInstallModal } from "./McpInstallModal";

type McpModalContextValue = {
  open: () => void;
  close: () => void;
  isOpen: boolean;
};

const McpModalContext = createContext<McpModalContextValue | null>(null);

export function McpModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ open, close, isOpen }), [open, close, isOpen]);

  return (
    <McpModalContext.Provider value={value}>
      {children}
      <McpInstallModal open={isOpen} onClose={close} />
    </McpModalContext.Provider>
  );
}

/** Open/close the global MCP-install modal. Safe no-op outside the provider so
 *  components that may render in tests without the shell don't crash. */
export function useMcpModal(): McpModalContextValue {
  const ctx = useContext(McpModalContext);
  if (!ctx) {
    return { open: () => {}, close: () => {}, isOpen: false };
  }
  return ctx;
}
