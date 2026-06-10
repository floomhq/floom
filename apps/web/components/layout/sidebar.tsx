"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, Box, Brain, CheckCircle, Clock, Settings, Menu, X, Plug, Plus, Search, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeModeButton } from "@/components/ThemeModeButton";
import { openCommandPalette } from "@/components/CommandPalette";
import { useApprovalsCount } from "@/lib/useApprovalsSync";
import { WorkspaceSwitcher } from "@/components/layout/WorkspaceSwitcher";
import { api } from "@/lib/api";
import type { CurrentUser } from "@/lib/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Exported so the Downstream host's sidebar overlay can compose the engine's
// brand mark + nav + primary actions and only add its account/workspace
// footer — keeping the dashboard UI in sync with the engine (no fork).
export function FloomMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Workeros"
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

// C6: Emily avatar — solid Workeros accent blue circle, no glyph.
// Used as the nav icon for the Assistant item in place of the generic Bot glyph.
// The accent blue (#59AAF8 / --accent in dark, hardcoded for light) is the
// Workeros brand blue Federico designated for Emily's identity.
function EmilyDot({ className }: { className?: string }) {
  return (
    <span
      className={cn("shrink-0 rounded-full", className)}
      style={{ background: "var(--emily-accent, #59AAF8)", width: "16px", height: "16px" }}
      aria-hidden="true"
    />
  );
}

// S24: Secrets removed from top-level nav; reachable as a third tab on
// /connections ("Connected" / "Browse" / "Secrets"). Connections + secrets
// are the same mental model (credentials a worker can read) so they share
// a surface.
// `hint` is surfaced as a native title tooltip on hover — the flat single-row
// nav has no room for a permanent subtitle without a redesign, so the
// employee-model microcopy ("Assistant = the thing you talk to"; "Workers run
// on triggers") lives in the tooltip instead (Federico 2026-06-02).
type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType | null;
  hint?: string;
  badge?: boolean;
  emilyDot?: boolean;
};

const nav: NavItem[] = [
  { href: "/overview", label: "Overview", icon: Activity },
  // FL9: Assistant above Workers — the thing you talk to comes before the
  // things that run on triggers.
  { href: "/assistant", label: "Assistant", icon: null, emilyDot: true, hint: "Chat, ask, delegate" },
  { href: "/workers", label: "Workers", icon: Box, hint: "Runs on triggers and schedules" },
  { href: "/brain", label: "Brain", icon: Brain },
  { href: "/runs", label: "Runs", icon: Clock },
  { href: "/approvals", label: "Approvals", icon: CheckCircle, badge: true },
  { href: "/connections", label: "Connections", icon: Plug },
];

export function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  // Shared source with /approvals: revalidates on focus + after any
  // approve/reject so the badge never drifts from the list (G5 P2).
  const pendingCount = useApprovalsCount();

  return (
    <nav className="flex-1 px-3 space-y-0.5">
      {nav.map((item) => {
        const active =
          item.href === "/overview"
            ? pathname === "/" || pathname === "/overview"
            : pathname === item.href || pathname.startsWith(item.href + "/");
        const showBadge = item.badge && pendingCount > 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            title={item.hint}
            className={cn(
              "flex h-9 items-center gap-2.5 rounded-[var(--radius-button)] px-2.5 text-sm font-medium transition-[background,color] duration-150 ease-[var(--ease)]",
              active
                ? "bg-[var(--active-nav-bg)] text-[var(--active-nav-text)] [&_svg]:text-[var(--active-nav-text)] [&_svg]:opacity-100"
                : "text-[var(--ink-soft)] hover:bg-[var(--active-nav-bg)] hover:text-ink [&_svg]:opacity-65"
            )}
          >
            {item.emilyDot ? (
              <EmilyDot />
            ) : item.icon ? (
              <item.icon className="w-4 h-4" />
            ) : null}
            {item.label}
            {showBadge && (
              <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--primary)] px-1 text-[10px] font-semibold leading-none text-[var(--primary-text)]">
                {pendingCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarPrimaryActions({ onNavigate }: { onNavigate?: () => void }) {
  const onSearch = () => {
    onNavigate?.();
    openCommandPalette();
  };
  return (
    <div className="px-3 pb-3 space-y-1.5">
      <Link
        href="/workers/new"
        onClick={onNavigate}
        className="flex h-9 items-center justify-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--primary)] px-2.5 text-sm font-medium text-[var(--primary-text)] shadow-[var(--shadow-btn)] hover:bg-[var(--solid-2)] transition-colors duration-150"
      >
        <Plus className="w-4 h-4" />
        New worker
      </Link>
      <button
        type="button"
        onClick={onSearch}
        className="flex h-8 w-full items-center gap-2 rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-transparent px-2.5 text-sm text-[var(--ink-mute)] hover:bg-[var(--active-nav-bg)] hover:text-ink transition-colors duration-150"
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
        <Link href="/overview" className="flex items-center gap-2">
          <FloomMark size={22} />
          <span className="font-semibold text-base tracking-tight">Workeros</span>
        </Link>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Open command palette"
            onClick={openCommandPalette}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-ink"
          >
            <Search className="w-5 h-5" />
          </button>
          <ThemeModeButton className="theme-mode-button-compact" />
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setOpen(true)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-ink"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </header>

      <aside className="sticky top-0 z-20 hidden h-screen w-[228px] flex-col border-r border-[var(--border-soft)] bg-[var(--bg-app)] md:flex">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-card/70 dark:bg-card/[0.055]" aria-hidden="true" />
        <div className="px-5 pt-6 pb-8">
          <Link href="/overview" className="flex items-center gap-2">
            <FloomMark size={22} />
            <span className="font-semibold text-base tracking-tight">WorkerOS</span>
          </Link>
        </div>
        <SidebarPrimaryActions />
        <NavLinks pathname={pathname} />
        <div className="mt-auto pt-3 border-t border-[var(--border-soft)]">
          <WorkspaceSwitcher />
        </div>
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
              <Link href="/overview" className="flex items-center gap-2" onClick={() => setOpen(false)}>
                <FloomMark size={22} />
                <span className="font-semibold text-base tracking-tight">Workeros</span>
              </Link>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-ink"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="py-3 flex-1 overflow-auto">
              <SidebarPrimaryActions onNavigate={() => setOpen(false)} />
              <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
            </div>
            <div className="pt-3 border-t border-[var(--border-soft)]">
              <WorkspaceSwitcher />
            </div>
            <UserProfileFooter onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}

// S29b: replaces the "Workeros" bottom-left footer with a user profile chip.
// Today's single-user v0 shows "Local user"; the cloud build (see
// hosted builds) will swap this for the
// signed-in Supabase user's email + avatar.
//
// V8 (Federico 2026-06-02): "have settings next to name, as the gear icon, not
// its own row." Settings is now a small gear-icon button inline on the name
// row instead of a separate full-width SidebarSettingsLink. Theme toggle stays
// on the right.
//
// M36: avatarUrl prop wired for Google OAuth picture. When provided, the
// profile chip shows the real photo. Backend dependency: GET /user/me must
// return { picture: string | null } and the caller must pass it here.
//
// M37: Clicking the profile chip (avatar + name) opens a dropdown with
// Settings and Sign out, so logout is reachable without hunting for the icon.
export function UserProfileFooter({
  onNavigate,
  avatarUrl,
}: { onNavigate?: () => void; avatarUrl?: string | null } = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const settingsActive = pathname === "/settings" || pathname.startsWith("/settings/");
  const [user, setUser] = useState<CurrentUser | null>(null);

  useEffect(() => {
    let active = true;
    api.me()
      .then((currentUser) => {
        if (active) setUser(currentUser);
      })
      .catch(() => {
        if (active) setUser(null);
      });
    return () => {
      active = false;
    };
  }, []);

  // Multi-member: prefer username, then email, then display_name
  const primary = (user as (typeof user & { username?: string | null }) | null)?.username
    || user?.email || user?.display_name || "Local user";
  const userRole = (user as (typeof user & { role?: string }) | null)?.role;
  const secondary = userRole === "admin" ? "Admin" : userRole === "member" ? "Member" : (user?.email ? "Signed in" : "Workeros");
  const initials = profileInitials(primary);

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Clearing the cookie is best-effort; navigate regardless.
    }
    onNavigate?.();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2 border-t border-[var(--border-soft)] px-3 py-3">
      {/* Profile chip — clicking opens a dropdown with Settings + Sign out (M37). */}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex items-center gap-2 min-w-0 flex-1 rounded-[var(--radius-button)] px-1 py-0.5 -mx-1 transition-[background,color] duration-150 ease-[var(--ease)]",
            "hover:bg-[var(--active-nav-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
          )}
          aria-label="Profile menu"
        >
          {/* M36: show Google avatar when avatarUrl is provided, else initials. */}
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt="Profile avatar"
              className="size-7 shrink-0 rounded-full border border-[var(--border-soft)] object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="size-7 shrink-0 rounded-full bg-muted text-foreground border border-[var(--border-soft)] grid place-items-center text-[11px] font-medium">
              {initials}
            </div>
          )}
          <div className="min-w-0 leading-tight text-left">
            <p className="text-xs font-medium text-foreground truncate">{primary}</p>
            <p className="text-[10px] text-muted-foreground truncate">{secondary}</p>
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-48 p-1">
          <DropdownMenuItem
            render={<Link href="/settings" onClick={onNavigate} />}
            className="flex items-center gap-2 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
          >
            <Settings className={cn("size-4", settingsActive && "text-[var(--active-nav-text)]")} />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => void logout()}
            className="flex items-center gap-2 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
          >
            <LogOut className="size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ThemeModeButton />
    </div>
  );
}

function profileInitials(value: string) {
  const local = value.includes("@") ? value.split("@", 1)[0] : value;
  const parts = local
    .split(/[\s._-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const letters = parts.length > 1 ? [parts[0][0], parts[1][0]] : [local[0], local[1]];
  return letters
    .filter(Boolean)
    .join("")
    .toUpperCase() || "LU";
}
