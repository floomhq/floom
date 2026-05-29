"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Shared tabs row at the top of /connections, /connections/browse,
// /connections/mcp, and /secrets. S41: added "MCP" tab for MCP server management.
export function ConnectionsTabs() {
  const pathname = usePathname();
  const tabs = [
    { href: "/connections", label: "Connected", match: (p: string) => p === "/connections" },
    { href: "/connections/browse", label: "Browse", match: (p: string) => p.startsWith("/connections/browse") },
    { href: "/connections/mcp", label: "MCP", match: (p: string) => p.startsWith("/connections/mcp") },
    { href: "/secrets", label: "Secrets", match: (p: string) => p.startsWith("/secrets") },
  ];

  return (
    <nav className="flex items-center gap-1 border-b border-line" aria-label="Connections sections">
      {tabs.map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={
              active
                ? "relative -mb-px inline-flex h-9 items-center px-3 text-sm font-medium text-[var(--accent)] border-b-2 border-[var(--accent)]"
                : "relative -mb-px inline-flex h-9 items-center px-3 text-sm font-medium text-muted-foreground hover:text-foreground border-b-2 border-transparent"
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
