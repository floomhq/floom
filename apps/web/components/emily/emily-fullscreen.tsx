"use client";

import { createContext, useContext, useMemo, useState } from "react";

// Emily true-fullscreen state (Federico 2026-06-17): the make-fullscreen control
// in the Emily dock header must expand Emily into the MAIN CONTENT AREA — the
// page pane collapses/hides while the LEFT app sidebar stays visible — not just
// widen the right rail. The dock and the page pane are sibling flex children in
// AppShell, so this shared context lets the dock toggle fullscreen and lets the
// AppShell hide the page pane in response (no `fixed inset-0` overlay that would
// also cover the nav).
type EmilyFullscreenValue = {
  fullscreen: boolean;
  setFullscreen: (value: boolean) => void;
  toggleFullscreen: () => void;
};

const EmilyFullscreenContext = createContext<EmilyFullscreenValue | null>(null);

export function EmilyFullscreenProvider({ children }: { children: React.ReactNode }) {
  const [fullscreen, setFullscreen] = useState(false);
  const value = useMemo<EmilyFullscreenValue>(
    () => ({
      fullscreen,
      setFullscreen,
      toggleFullscreen: () => setFullscreen((v) => !v),
    }),
    [fullscreen],
  );
  return (
    <EmilyFullscreenContext.Provider value={value}>
      {children}
    </EmilyFullscreenContext.Provider>
  );
}

// Safe default when rendered outside a provider (e.g. the /chat full-page route
// or isolated tests) — fullscreen is a no-op there.
export function useEmilyFullscreen(): EmilyFullscreenValue {
  const ctx = useContext(EmilyFullscreenContext);
  if (ctx) return ctx;
  return {
    fullscreen: false,
    setFullscreen: () => {},
    toggleFullscreen: () => {},
  };
}
