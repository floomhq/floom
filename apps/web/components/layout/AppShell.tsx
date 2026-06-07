"use client";

import { usePathname } from "next/navigation";
import { Ambient } from "@/components/Ambient";
import { CommandPalette } from "@/components/CommandPalette";
import { IconSprite } from "@/components/IconSprite";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/layout/sidebar";
import { EmilyDock } from "@/components/emily/EmilyChat";

// Public, shareable "skill card" pages render full-bleed without the app
// sidebar / command palette. /w and /s are standalone public share pages.
// /login is the access gate -- it must render without sidebar chrome (and is
// the one page reachable while logged out, see middleware.ts).
const standalonePrefixes = ["/approvals/review", "/w", "/s", "/login"];

// The full-page /chat route renders its own Emily header; no dock needed there.
const noDockPrefixes = ["/chat"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const standalone = standalonePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  const noDock = noDockPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  if (standalone) {
    return (
      <>
        <IconSprite />
        <Ambient />
        <main className="relative z-10 min-h-screen w-full">{children}</main>
        <Toaster position="bottom-right" />
      </>
    );
  }

  if (noDock) {
    // Full-page chat: sidebar + full-bleed main (no content padding, no dock)
    return (
      <>
        <IconSprite />
        <Ambient />
        <Sidebar />
        <main className="relative z-10 flex-1 min-w-0 min-h-screen">{children}</main>
        <CommandPalette />
        <Toaster position="bottom-right" />
      </>
    );
  }

  return (
    <>
      <IconSprite />
      <Ambient />
      <Sidebar />
      {/* Main content between sidebar and Emily dock — scrolls in its own
          container. FL18: the inner wrapper is a full-height flex column
          (min-h-full) so pages and their loading skeletons fill the viewport
          by default instead of leaving dead whitespace at the bottom. */}
      <main className="relative z-10 flex-1 min-w-0 h-full overflow-y-auto">
        <div className="flex min-h-full flex-col max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</div>
      </main>
      {/* Emily dock: fixed-height right rail — scrolls internally, never bleeds to body */}
      <EmilyDock className="hidden md:flex" />
      <CommandPalette />
      <Toaster position="bottom-right" />
    </>
  );
}
