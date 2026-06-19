"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Ambient } from "@/components/Ambient";
import { CommandPalette } from "@/components/CommandPalette";
import { IconSprite } from "@/components/IconSprite";
import { TelemetryProvider } from "@/components/TelemetryProvider";
import { CloudAccountFooter } from "@/components/CloudAccountFooter";
import { EmilyDock } from "@/components/emily/EmilyChat";
import { EmilyFullscreenProvider, useEmilyFullscreen } from "@/components/emily/emily-fullscreen";
import { Sidebar } from "@/components/layout/sidebar";
import { Toaster } from "@/components/ui/sonner";

// Mirror of the engine AppShell useIsDesktop: render exactly one Emily surface
// and gate true-fullscreen to desktop (the dock is a flex sibling of the page
// pane on desktop only). Defaults to desktop to match SSR (no hydration
// mismatch), corrected on mount.
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

export function CloudAppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPath = pathname === "/login" || pathname.startsWith("/login/") || pathname === "/app/login" || pathname.startsWith("/app/login/");
  const isJoinPath = pathname === "/join" || pathname.startsWith("/join/") || pathname === "/app/join" || pathname.startsWith("/app/join/");
  // cli-auth is a standalone approval gate (no sidebar/dock chrome): the engine
  // page centers itself + is in the engine standalonePrefixes. Mirror the login
  // standalone treatment so it escapes the shell. Match both /cli-auth and
  // /app/cli-auth (basePath-aware, same as isLoginPath).
  const isCliAuthPath = pathname === "/cli-auth" || pathname.startsWith("/cli-auth/") || pathname === "/app/cli-auth" || pathname.startsWith("/app/cli-auth/");
  const isApprovalReviewPath =
    pathname === "/approvals/review" ||
    pathname.startsWith("/approvals/review/") ||
    pathname === "/app/approvals/review" ||
    pathname.startsWith("/app/approvals/review/");
  const isChatPath =
    pathname === "/chat" ||
    pathname.startsWith("/chat/") ||
    pathname === "/app/chat" ||
    pathname.startsWith("/app/chat/");

  // #1218 / engine #1101: collection pages (Brain split-view, Workers, Runs,
  // Connections, Approvals) own their internal flex-column layout and MUST fill
  // the full viewport height so their split divider reaches the bottom. The
  // engine AppShell renders these full-bleed (no max-w-7xl/padding wrapper) so
  // the CollectionView's height:100% resolves against a definite-height flex
  // column. The Cloud chrome previously wrapped EVERY page in the padded
  // max-w-7xl container, which broke the height chain on cloud — so the brain
  // divider stopped short of the viewport bottom. Mirror the engine here.
  const isFullBleedCollectionPath = [
    "/brain",
    "/workers",
    "/runs",
    "/connections",
    "/approvals",
  ].some(
    (base) =>
      pathname === base ||
      pathname.startsWith(`${base}/`) ||
      pathname === `/app${base}` ||
      pathname.startsWith(`/app${base}/`),
  ) && !isApprovalReviewPath;

  if (isLoginPath || isJoinPath) {
    return (
      <>
        <IconSprite />
        {/* flex-1 w-full: on desktop the cloud-app-shell body is flex-direction:row;
            without this wrapper the login <main> shrinks to content width and
            left-aligns. flex-1 fills the row, w-full ensures the inner grid
            place-items-center centres the auth card correctly. */}
        <div className="flex-1 w-full">
          {children}
        </div>
        <Toaster position="bottom-right" />
      </>
    );
  }

  if (isApprovalReviewPath || isCliAuthPath) {
    return (
      <>
        <IconSprite />
        <Ambient />
        <main className="relative z-10 min-h-screen w-full">{children}</main>
        <TelemetryProvider />
        <Toaster position="bottom-right" />
      </>
    );
  }

  if (isChatPath) {
    return (
      <>
        <IconSprite />
        <Ambient />
        <Sidebar accountFooter={({ onNavigate }) => <CloudAccountFooter onNavigate={onNavigate} />} />
        <main className="relative z-10 flex-1 min-w-0 min-h-screen">{children}</main>
        <CommandPalette />
        <TelemetryProvider />
        <Toaster position="bottom-right" />
      </>
    );
  }

  // Emily true-fullscreen (Federico 2026-06-17): mirror the engine AppShell —
  // wrap the standard shell body in EmilyFullscreenProvider so the dock's
  // expand control (⤢) toggles a SHARED state that this chrome reads to hide
  // the page pane, letting Emily flex-grow into the main area while the left
  // sidebar stays. Without the provider the dock falls back to the no-op
  // context and the control is inert (the bug). Reuse the engine context — do
  // NOT fork a second fullscreen state.
  return (
    <EmilyFullscreenProvider>
      <IconSprite />
      <Ambient />
      <Sidebar accountFooter={({ onNavigate }) => <CloudAccountFooter onNavigate={onNavigate} />} />
      <CloudShellBody isFullBleedCollectionPath={isFullBleedCollectionPath}>
        {children}
      </CloudShellBody>
      <CommandPalette />
      <TelemetryProvider />
      <Toaster position="bottom-right" />
    </EmilyFullscreenProvider>
  );
}

// Inner body that consumes the Emily fullscreen context. When Emily is in true
// fullscreen on desktop, the page pane (<main>) is hidden (display:none, stays
// mounted so page state survives) so the EmilyDock — already flex-grows to
// `flex-1 min-w-0` when fullscreen via the shared context — fills the main
// area to the RIGHT of the left sidebar, which stays visible. On mobile the
// dock is hidden (`hidden md:flex`) and fullscreen is a no-op. Mirrors the
// engine AppShell StandardShellBody.
function CloudShellBody({
  children,
  isFullBleedCollectionPath,
}: {
  children: React.ReactNode;
  isFullBleedCollectionPath: boolean;
}) {
  const { fullscreen } = useEmilyFullscreen();
  const isDesktop = useIsDesktop();
  const emilyFull = fullscreen && isDesktop;

  return (
    <>
      {/* #1218: collection pages render full-bleed (no padded max-w-7xl wrapper)
          so their flex-column fills the viewport height and the split divider
          reaches the bottom — matching the engine AppShell (#1101). Standard
          pages keep the centered, padded, scroll container. */}
      {isFullBleedCollectionPath ? (
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
      <EmilyDock className="hidden md:flex" />
    </>
  );
}
