"use client";

import { usePathname } from "next/navigation";
import { Ambient } from "@/components/Ambient";
import { CommandPalette } from "@/components/CommandPalette";
import { IconSprite } from "@/components/IconSprite";
import { TelemetryProvider } from "@/components/TelemetryProvider";
import { CloudAccountFooter } from "@/components/CloudAccountFooter";
import { EmilyDock } from "@/components/emily/EmilyChat";
import { Sidebar } from "@/components/layout/sidebar";
import { Toaster } from "@/components/ui/sonner";

export function CloudAppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPath = pathname === "/login" || pathname.startsWith("/login/") || pathname === "/app/login" || pathname.startsWith("/app/login/");
  const isJoinPath = pathname === "/join" || pathname.startsWith("/join/") || pathname === "/app/join" || pathname.startsWith("/app/join/");
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

  if (isApprovalReviewPath) {
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

  return (
    <>
      <IconSprite />
      <Ambient />
      <Sidebar accountFooter={({ onNavigate }) => <CloudAccountFooter onNavigate={onNavigate} />} />
      {/* #1218: collection pages render full-bleed (no padded max-w-7xl wrapper)
          so their flex-column fills the viewport height and the split divider
          reaches the bottom — matching the engine AppShell (#1101). Standard
          pages keep the centered, padded, scroll container. */}
      {isFullBleedCollectionPath ? (
        <main className="relative z-10 flex-1 min-w-0 h-full overflow-hidden flex flex-col">
          {children}
        </main>
      ) : (
        <main className="relative z-10 flex-1 min-w-0 h-full overflow-y-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 flex flex-col min-h-full">{children}</div>
        </main>
      )}
      <EmilyDock className="hidden md:flex" />
      <CommandPalette />
      <TelemetryProvider />
      <Toaster position="bottom-right" />
    </>
  );
}
