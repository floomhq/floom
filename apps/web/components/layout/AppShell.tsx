"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Ambient } from "@/components/Ambient";
import { CommandPalette } from "@/components/CommandPalette";
import { IconSprite } from "@/components/IconSprite";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/layout/sidebar";
import { DeepLinkRouter } from "@/components/layout/DeepLinkRouter";
import { EmilyDock, EmilyMobileSheet } from "@/components/emily/EmilyChat";
import { EmilyFullscreenProvider, useEmilyFullscreen } from "@/components/emily/emily-fullscreen";
import { AlertsBell } from "@/components/overview/AlertsBell";
import { BootSplash } from "@/components/layout/BootSplash";

// Render exactly one Emily surface so only one chat instance mounts: the
// desktop dock (≥768px) or the mobile bottom-sheet (<768px). Defaults to
// desktop to match SSR (no hydration mismatch), corrected on mount.
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(true);
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
const standalonePrefixes = ["/approvals/review", "/w", "/s", "/login", "/run", "/preview"];

// The full-page /chat route renders its own Emily header; no dock needed there.
// /workers/new is the hero hire flow — it needs full-width, no dock cramping it.
const noDockPrefixes = ["/chat", "/workers/new"];

// Collection pages manage their own internal layout (header + split detail that
// must reach the bottom of the viewport). They render inside the standard
// sidebar shell but WITHOUT the max-w-7xl/padding content wrapper so the
// Collection's flex-column can fill the available height correctly. (#1101)
const fullBleedCollectionPaths = ["/library", "/brain", "/workers", "/runs", "/connections", "/approvals"];

export type AppShellProps = {
  children: React.ReactNode;
  noSidebarPaths?: string[];
};

function pathMatchesPrefixes(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// #1292: app-wide alerts bell. Anchored to the top-right of the MAIN content
// pane (the flex child between the sidebar and the Emily dock) so the
// needs-attention surface (failing workers, missing secrets/connections,
// expiring connections, pending approvals) is reachable from every page, not
// just /overview. Anchoring to the pane — not the viewport — keeps it left of
// the Emily dock regardless of the dock's current width (rail/wide/full).
// Self-fetches its data (no `items` prop). Desktop only — the mobile top bar
// carries its own bell (see sidebar.tsx). z-30 sits above page content; the
// dropdown opens leftward (right-0) so it stays inside the pane.
function GlobalAlertsBell() {
  return (
    <div className="pointer-events-none absolute right-3 top-2 z-30 hidden md:block">
      <div className="pointer-events-auto">
        <AlertsBell />
      </div>
    </div>
  );
}

export function AppShell({ children, noSidebarPaths = [] }: AppShellProps) {
  const pathname = usePathname();
  const isDesktop = useIsDesktop();
  const standalone = pathMatchesPrefixes(pathname, standalonePrefixes)
    || pathMatchesPrefixes(pathname, noSidebarPaths);
  const noDock = pathMatchesPrefixes(pathname, noDockPrefixes);
  const fullBleed = pathMatchesPrefixes(pathname, fullBleedCollectionPaths);

  if (standalone) {
    return (
      <>
        <BootSplash />
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
        <BootSplash />
        <IconSprite />
        <Ambient />
        <DeepLinkRouter />
        <Sidebar />
        <main className="relative z-10 flex-1 min-w-0 min-h-screen">
          <GlobalAlertsBell />
          {children}
        </main>
        <CommandPalette />
        <Toaster position="bottom-right" closeButton />
      </>
    );
  }

  return (
    <EmilyFullscreenProvider>
      <BootSplash />
      <IconSprite />
      <Ambient />
      <DeepLinkRouter />
      <Sidebar />
      <StandardShellBody fullBleed={fullBleed} isDesktop={isDesktop}>
        {children}
      </StandardShellBody>
      <CommandPalette />
      <Toaster position="bottom-right" closeButton />
    </EmilyFullscreenProvider>
  );
}

// Inner body that consumes the Emily fullscreen context. When Emily is in true
// fullscreen, the page pane (<main>) is hidden so Emily flex-grows to fill the
// whole main area (everything to the RIGHT of the left sidebar, which stays
// visible — Federico 2026-06-17 spec). The GlobalAlertsBell also hides with the
// pane since there is no page content to anchor it to.
function StandardShellBody({
  children,
  fullBleed,
  isDesktop,
}: {
  children: React.ReactNode;
  fullBleed: boolean;
  isDesktop: boolean;
}) {
  const { fullscreen } = useEmilyFullscreen();
  // Fullscreen only applies on desktop where the dock is a flex sibling of the
  // page pane. On mobile the bottom-sheet owns its own overlay.
  const emilyFull = fullscreen && isDesktop;

  return (
    <>
      {/* Main content between sidebar and Emily dock.
          fullBleed pages (collection pages) own their own internal layout and
          must fill the full viewport height (they skip the max-w-7xl wrapper).
          Standard pages scroll in the overflow-y-auto container. (#1101)
          When Emily is fullscreen the pane is hidden (display:none, stays mounted
          so page state survives) and Emily fills the row. */}
      {fullBleed ? (
        <main
          className={cn(
            "relative z-10 flex-1 min-w-0 h-full overflow-hidden flex-col",
            emilyFull ? "hidden" : "flex",
          )}
        >
          <GlobalAlertsBell />
          {children}
        </main>
      ) : (
        <main
          className={cn(
            "relative z-10 flex-1 min-w-0 h-full overflow-y-auto",
            emilyFull && "hidden",
          )}
        >
          {/* Zero-height sticky bar keeps the bell pinned to the pane's
              top-right while the page content scrolls underneath it. */}
          <div className="pointer-events-none sticky top-0 z-30 hidden h-0 md:block">
            <div className="pointer-events-auto absolute right-3 top-2">
              <AlertsBell />
            </div>
          </div>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col min-h-full">{children}</div>
        </main>
      )}
      {/* Emily dock: fixed-height right rail — scrolls internally, never bleeds to body */}
      {isDesktop ? <EmilyDock /> : <EmilyMobileSheet />}
    </>
  );
}
