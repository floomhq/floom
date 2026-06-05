"use client";

import { usePathname } from "next/navigation";
import { Ambient } from "@/components/Ambient";
import { CommandPalette } from "@/components/CommandPalette";
import { IconSprite } from "@/components/IconSprite";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/layout/sidebar";

// Public, shareable "skill card" pages render full-bleed without the app
// sidebar / command palette. /w and /s are standalone public share pages.
// /login is the access gate — it must render without sidebar chrome (and is
// the one page reachable while logged out, see middleware.ts).
const standalonePrefixes = ["/approvals/review", "/w", "/s", "/login"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const standalone = standalonePrefixes.some(
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

  return (
    <>
      <IconSprite />
      <Ambient />
      <Sidebar />
      <main className="relative z-10 flex-1 min-w-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</div>
      </main>
      <CommandPalette />
      <Toaster position="bottom-right" />
    </>
  );
}
