"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, Box, Clock, Folder, Settings, Menu, X, Plug, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeModeButton } from "@/components/ThemeModeButton";
import { openCommandPalette } from "@/components/CommandPalette";

function FloomMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Floom"
      style={{ borderRadius: "22%" }}
    >
      <rect width="100" height="100" rx="22" fill="var(--primary)" />
      <path
        d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
        fill="var(--bg-app)"
      />
    </svg>
  );
}

// S24: Secrets removed from top-level nav; reachable as a third tab on
// /connections ("Connected" / "Browse" / "Secrets"). Connections + secrets
// are the same mental model (credentials a worker can read) so they share
// a surface.
const nav = [
  { href: "/overview", label: "Overview", icon: Activity },
  { href: "/workers", label: "Workers", icon: Box },
  { href: "/contexts", label: "Contexts", icon: Folder },
  { href: "/runs", label: "Runs", icon: Clock },
  { href: "/connections", label: "Connections", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex-1 px-3 space-y-0.5">
      {nav.map((item) => {
        const active =
          item.href === "/overview"
            ? pathname === "/" || pathname === "/overview"
            : pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex h-9 items-center gap-2.5 rounded-xl px-2.5 text-sm font-medium transition-[background,color] duration-150 ease-[var(--ease)]",
              active
                ? "bg-[var(--active-nav-bg)] text-[var(--active-nav-text)] [&_svg]:text-[var(--active-nav-text)] [&_svg]:opacity-100"
                : "text-[var(--ink-soft)] hover:bg-[var(--active-nav-bg)] hover:text-ink [&_svg]:opacity-65"
            )}
          >
            <item.icon className="w-4 h-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarPrimaryActions({ onNavigate }: { onNavigate?: () => void }) {
  const onSearch = () => {
    onNavigate?.();
    openCommandPalette();
  };
  return (
    <div className="px-3 pb-3 space-y-1.5">
      <Link
        href="/workers/new"
        onClick={onNavigate}
        className="flex h-9 items-center justify-center gap-1.5 rounded-xl bg-[var(--primary)] px-2.5 text-sm font-medium text-[var(--primary-text)] shadow-[var(--shadow-btn)] hover:bg-[var(--solid-2)] transition-colors duration-150"
      >
        <Plus className="w-4 h-4" />
        New worker
      </Link>
      <button
        type="button"
        onClick={onSearch}
        className="flex h-8 w-full items-center gap-2 rounded-lg border border-[var(--border-soft)] bg-transparent px-2.5 text-sm text-[var(--ink-mute)] hover:bg-[var(--active-nav-bg)] hover:text-ink transition-colors duration-150"
        aria-label="Open command palette"
      >
        <Search className="w-4 h-4 opacity-70" />
        <span>Search...</span>
        <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] tracking-widest text-[var(--ink-faint)]">
          <kbd className="rounded border border-[var(--border-soft)] bg-[var(--bg-2)] px-1 py-0.5 text-[11px] leading-none font-sans" style={{ fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>⌘</kbd>
          <kbd className="rounded border border-[var(--border-soft)] bg-[var(--bg-2)] px-1 py-0.5 font-mono">K</kbd>
        </span>
      </button>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close mobile nav on route changes; wrap in a callback to avoid
  // "setState synchronously inside an effect" lint rule
  useEffect(() => {
    const close = () => setOpen(false);
    close();
  }, [pathname]);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-[var(--border-soft)] bg-[var(--bg-app)] px-4 md:hidden">
        <Link href="/" className="flex items-center gap-2">
          <FloomMark size={28} />
          <span className="font-semibold text-[15px] tracking-tight">Floom</span>
        </Link>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Open command palette"
            onClick={openCommandPalette}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-ink"
          >
            <Search className="w-5 h-5" />
          </button>
          <ThemeModeButton className="theme-mode-button-compact" />
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setOpen(true)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-ink"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </header>

      <aside className="sticky top-0 z-20 hidden h-screen w-60 flex-col border-r border-[var(--border-soft)] bg-[var(--bg-app)] md:flex">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-card/70 dark:bg-card/[0.055]" aria-hidden="true" />
        <div className="px-5 pt-6 pb-8">
          <Link href="/" className="flex items-center gap-2">
            <FloomMark size={28} />
            <span className="font-semibold text-[15px] tracking-tight">Floom</span>
          </Link>
        </div>
        <SidebarPrimaryActions />
        <NavLinks pathname={pathname} />
        <UserProfileFooter />
      </aside>

      {open && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-50 flex h-full w-64 max-w-[80vw] flex-col border-r border-[var(--border-soft)] bg-[var(--bg-app)] shadow-pop">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-card/70 dark:bg-card/[0.055]" aria-hidden="true" />
            <div className="flex items-center justify-between border-b border-[var(--border-soft)] px-5 py-4">
              <Link href="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
                <FloomMark size={28} />
                <span className="font-semibold text-[15px] tracking-tight">Floom</span>
              </Link>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-ink"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="py-3 flex-1 overflow-auto">
              <SidebarPrimaryActions onNavigate={() => setOpen(false)} />
              <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
            </div>
            <UserProfileFooter />
          </aside>
        </div>
      )}
    </>
  );
}

// S29b: replaces the "Floom v0" bottom-left footer with a user profile chip.
// Today's single-user v0 shows "Local user"; the cloud build (see
// docs/architecture/supabase-cloud-wiring-brief.md) will swap this for the
// signed-in Supabase user's email + avatar. Theme toggle stays on the right.
function UserProfileFooter() {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--border-soft)] px-3 py-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="size-7 shrink-0 rounded-full bg-muted text-foreground border border-[var(--border-soft)] grid place-items-center text-[11px] font-medium">
          LU
        </div>
        <div className="min-w-0 leading-tight">
          <p className="text-xs font-medium text-foreground truncate">Local user</p>
          <p className="text-[10px] text-muted-foreground truncate">Workeros v0</p>
        </div>
      </div>
      <ThemeModeButton />
    </div>
  );
}
