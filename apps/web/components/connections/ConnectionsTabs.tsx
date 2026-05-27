"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// S23: shared tabs row mounted at the top of both /connections (Connected)
// and /connections/browse (Browse). Visual unification without merging the
// page code (each route still owns its data fetching and chrome).
export function ConnectionsTabs() {
  const pathname = usePathname();
  const tabs = [
    { href: "/connections", label: "Connected" },
    { href: "/connections/browse", label: "Browse" },
  ];

  return (
    <nav className="flex items-center gap-1 border-b border-line" aria-label="Connections sections">
      {tabs.map((tab) => {
        const active =
          tab.href === "/connections"
            ? pathname === "/connections"
            : pathname.startsWith(tab.href);
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
