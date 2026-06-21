"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Chip-style segmented nav across the four Connections surfaces
// (Connected / Browse apps / MCP / Secrets). Replaces the deleted
// ConnectionsTabs underlined tab row (Federico 2026-06-19: "the chips to
// filter are enough") and the round-09 batch2 Browse-button + sidebar-Secrets
// IA, which is reverted.
//
// Styling reuses the canonical cool-palette filter chip DS (`.c-tag` /
// `.c-tag.on`, the same primitive TagBar's status filters use): subtle pill at
// rest (var(--bg-2) + pill radius), filled/emphasized when active
// (var(--primary) fill + var(--primary-text)). Flat squircle/pill, no new
// borders/gradients/emojis.
//
// P2-9 (audit 2026-05-29): every surface shares the /connections/* route
// prefix; the legacy /secrets path redirects to /connections/secrets.
export function ConnectionsChips() {
  const pathname = usePathname();
  const chips = [
    { href: "/connections", label: "Connected", match: (p: string) => p === "/connections" },
    { href: "/connections/browse", label: "Browse apps", match: (p: string) => p.startsWith("/connections/browse") },
    { href: "/connections/mcp", label: "MCP", match: (p: string) => p.startsWith("/connections/mcp") },
    { href: "/connections/secrets", label: "Secrets", match: (p: string) => p.startsWith("/connections/secrets") || p.startsWith("/secrets") },
    // Slack is the HUMAN INTERFACE (DM assistant, @mention, approvals) —
    // NOT a worker OAuth connection. It lives at Settings → Slack (#slack).
    // /connections/slack redirects there. DO NOT add a Slack chip here.
  ];

  return (
    <nav className="c-tagbar" aria-label="Connections sections">
      {chips.map((chip) => {
        const active = chip.match(pathname);
        return (
          <Link
            key={chip.href}
            href={chip.href}
            className={`c-tag${active ? " on" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {chip.label}
          </Link>
        );
      })}
    </nav>
  );
}
