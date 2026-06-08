"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Shared tabs row at the top of the four Connections surfaces. P2-9 (audit
// 2026-05-29): Secrets moved from /secrets to /connections/secrets so every
// tab shares the same /connections/* route prefix (consistent path-state
// routing). The legacy /secrets path redirects here.
export function ConnectionsTabs() {
  const pathname = usePathname();
  const tabs = [
    { href: "/connections", label: "Connected", match: (p: string) => p === "/connections" },
    { href: "/connections/mcp", label: "MCP", match: (p: string) => p.startsWith("/connections/mcp") },
    { href: "/connections/secrets", label: "Secrets", match: (p: string) => p.startsWith("/connections/secrets") || p.startsWith("/secrets") },
    // Slack is the HUMAN INTERFACE (DM assistant, @mention, approvals) —
    // NOT a worker OAuth connection. It lives at Settings → Slack (#slack).
    // /connections/slack redirects there. DO NOT add a Slack tab here.
  ];

  return (
    <nav className="-mx-4 flex items-center overflow-x-auto border-b border-line px-4 sm:mx-0 sm:gap-1 sm:px-0" aria-label="Connections sections">
      {tabs.map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={
              active
                ? "relative -mb-px inline-flex h-9 shrink-0 items-center px-2 text-sm font-medium text-[var(--accent)] border-b-2 border-[var(--accent)] sm:px-3"
                : "relative -mb-px inline-flex h-9 shrink-0 items-center px-2 text-sm font-medium text-muted-foreground hover:text-foreground border-b-2 border-transparent sm:px-3"
            }
            aria-current={active ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
