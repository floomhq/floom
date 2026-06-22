"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useIsDesktop } from "@/lib/use-is-desktop";
import { Ambient } from "@/components/Ambient";
import { CommandPalette } from "@/components/CommandPalette";
import { IconSprite } from "@/components/IconSprite";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/layout/sidebar";
import { DeepLinkRouter } from "@/components/layout/DeepLinkRouter";
import { EmilyDock, EmilyMobileSheet } from "@/components/emily/EmilyChat";
import { EmilyFullscreenProvider, useEmilyFullscreen } from "@/components/emily/emily-fullscreen";
import { BootSplash } from "@/components/layout/BootSplash";
import { McpModalProvider } from "@/components/mcp/mcp-modal-context";

// Render exactly one Emily surface so only one chat instance mounts: the
// desktop dock (≥1024px) or the mobile/tablet bottom-sheet (<1024px).
// `useIsDesktop` (lib/use-is-desktop) defaults to mobile so small viewports
// always get the mobile Emily affordance, then syncs to the real breakpoint on
// mount. The 1024 boundary (#1544) keeps the docked Emily off the tablet range
// (768–1023), where the 3-column shell would crush the content pane.

// Public, shareable "skill card" pages render full-bleed without the app
// sidebar / command palette. /w and /s are standalone public share pages.
// /login is the access gate -- it must render without sidebar chrome (and is
// the one page reachable while logged out, see middleware.ts).
const standalonePrefixes = ["/approvals/review", "/w", "/s", "/login", "/run", "/preview", "/cli-auth"];

// The full-page /chat route renders its own Emily header; no dock needed there.
// /workers/new is the hero hire flow — it needs full-width, no dock cramping it.
const noDockPrefixes = ["/chat", "/workers/new"];

// Collection pages manage their own internal layout (header + split detail that
// must reach the bottom of the viewport). They render inside the standard
// sidebar shell but WITHOUT the max-w-7xl/padding content wrapper so the
// Collection's flex-column can fill the available height correctly. (#1101)
// The Emily-fullscreen HOME ("/" and "/overview") is composer-anchored and must
// fill the whole pane (no max-w-7xl/padding wrapper), like the collection pages.
const fullBleedCollectionPaths = ["/", "/overview", "/library", "/brain", "/workers", "/runs", "/connections", "/approvals"];

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
        {/* The <body> is `h-screen overflow-hidden`, so a standalone page needs
            its OWN scroll container or any content taller than the viewport is
            clipped and unreachable. `min-h-screen` alone grew the page past the
            fold with nothing able to scroll to it (#1717: the /approvals/review
            multi-item proposed output was clipped). `h-full overflow-y-auto`
            makes this pane the scroller, matching standard app pages. */}
        <main className="relative z-10 h-full w-full overflow-y-auto">{children}</main>
        <Toaster position="bottom-right" closeButton />
      </>
    );
  }

  if (noDock) {
    // Full-page chat: sidebar + full-bleed main (no content padding, no dock)
    return (
      <McpModalProvider>
        <BootSplash />
        <IconSprite />
        <Ambient />
        <DeepLinkRouter />
        <Sidebar />
        <main className="relative z-10 flex-1 min-w-0 min-h-screen">
          {children}
        </main>
        <CommandPalette />
        <Toaster position="bottom-right" closeButton />
      </McpModalProvider>
    );
  }

  return (
    <McpModalProvider>
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
    </McpModalProvider>
  );
}

// Inner body that consumes the Emily fullscreen context. When Emily is in true
// fullscreen, the page pane (<main>) is hidden so Emily flex-grows to fill the
// whole main area (everything to the RIGHT of the left sidebar, which stays
// visible — Federico 2026-06-17 spec).
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
          {children}
        </main>
      ) : (
        <main
          className={cn(
            "relative z-10 flex-1 min-w-0 h-full overflow-y-auto",
            emilyFull && "hidden",
          )}
        >
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col min-h-full">{children}</div>
        </main>
      )}
      {/* Emily dock: fixed-height right rail — scrolls internally, never bleeds to body */}
      {isDesktop ? <EmilyDock /> : <EmilyMobileSheet />}
    </>
  );
}
