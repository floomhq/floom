"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Ambient } from "@/components/Ambient";
import { CommandPalette } from "@/components/CommandPalette";
import { IconSprite } from "@/components/IconSprite";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/layout/sidebar";
import { DeepLinkRouter } from "@/components/layout/DeepLinkRouter";
import { EmilyDock, EmilyMobileSheet } from "@/components/emily/EmilyChat";
import type { DockMode } from "@/components/emily/EmilyChat";

// #1231/#1309: expose the Emily dock width state so Overview (and other
// pages) can reflow their grid when the dock is wide or full.
export type EmilyDockMode = DockMode;
export const EmilyDockModeContext = createContext<EmilyDockMode>("rail");
export function useEmilyDockMode() {
  return useContext(EmilyDockModeContext);
}

// Render exactly one Emily surface so only one chat instance mounts: the
// desktop dock (≥768px) or the mobile bottom-sheet (<768px).
// #1307: start as null (unknown) to avoid the desktop↔mobile remount flicker
// on hydration. Emily renders nothing until the MQ resolves on the client —
// this eliminates the "disappears then reappears" caused by an incorrect SSR
// guess being corrected on first paint.
function useIsDesktop(): boolean | null {
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return isDesktop;
}

// Public, shareable "skill card" pages render full-bleed without the app
// sidebar / command palette. /w and /s are standalone public share pages.
// /login is the access gate -- it must render without sidebar chrome (and is
// the one page reachable while logged out, see middleware.ts).
const standalonePrefixes = ["/approvals/review", "/w", "/s", "/login"];

// The full-page /chat route renders its own Emily header; no dock needed there.
// /workers/new is the hero hire flow — it needs full-width, no dock cramping it.
const noDockPrefixes = ["/chat", "/workers/new"];

// Collection pages manage their own internal layout (header + split detail that
// must reach the bottom of the viewport). They render inside the standard
// sidebar shell but WITHOUT the max-w-7xl/padding content wrapper so the
// Collection's flex-column can fill the available height correctly. (#1101)
const fullBleedCollectionPaths = ["/brain", "/workers", "/runs", "/connections", "/approvals"];

export type AppShellProps = {
  children: React.ReactNode;
  noSidebarPaths?: string[];
};

function pathMatchesPrefixes(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function AppShell({ children, noSidebarPaths = [] }: AppShellProps) {
  const pathname = usePathname();
  const isDesktop = useIsDesktop();
  // #1231/#1309: track dock mode so layout-aware pages (Overview) can reflow.
  const [dockMode, setDockMode] = useState<EmilyDockMode>("rail");
  const standalone = pathMatchesPrefixes(pathname, standalonePrefixes)
    || pathMatchesPrefixes(pathname, noSidebarPaths);
  const noDock = pathMatchesPrefixes(pathname, noDockPrefixes);
  const fullBleed = pathMatchesPrefixes(pathname, fullBleedCollectionPaths);

  if (standalone) {
    return (
      <>
        <IconSprite />
        <Ambient />
        <main className="relative z-10 min-h-screen w-full">{children}</main>
        <Toaster position="bottom-right" closeButton />
      </>
    );
  }

  if (noDock) {
    // Full-page chat: sidebar + full-bleed main (no content padding, no dock)
    return (
      <>
        <IconSprite />
        <Ambient />
        <DeepLinkRouter />
        <Sidebar />
        <main className="relative z-10 flex-1 min-w-0 min-h-screen">{children}</main>
        <CommandPalette />
        <Toaster position="bottom-right" closeButton />
      </>
    );
  }

  return (
    <EmilyDockModeContext.Provider value={dockMode}>
      <IconSprite />
      <Ambient />
      <DeepLinkRouter />
      <Sidebar />
      {/* Main content between sidebar and Emily dock.
          fullBleed pages (collection pages) own their own internal layout and
          must fill the full viewport height (they skip the max-w-7xl wrapper).
          Standard pages scroll in the overflow-y-auto container. (#1101) */}
      {fullBleed ? (
        <main className="relative z-10 flex-1 min-w-0 h-full overflow-hidden flex flex-col">
          {children}
        </main>
      ) : (
        <main className="relative z-10 flex-1 min-w-0 h-full overflow-y-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col min-h-full">{children}</div>
        </main>
      )}
      {/* Emily dock: fixed-height right rail — scrolls internally, never bleeds to body.
          #1307: isDesktop is null until the MQ resolves (avoids desktop↔mobile remount flicker
          that caused "disappears then reappears" on tab change — the wrong surface was
          rendered during SSR, then corrected on hydration, causing a visible flash). */}
      {isDesktop === null ? null : isDesktop
        ? <EmilyDock onModeChange={setDockMode} />
        : <EmilyMobileSheet />
      }
      <CommandPalette />
      <Toaster position="bottom-right" closeButton />
    </EmilyDockModeContext.Provider>
  );
}
