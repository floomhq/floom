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
      <main className="relative z-10 flex-1 min-w-0 h-full overflow-y-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</div>
      </main>
      <EmilyDock className="hidden md:flex" />
      <CommandPalette />
      <TelemetryProvider />
      <Toaster position="bottom-right" />
    </>
  );
}
