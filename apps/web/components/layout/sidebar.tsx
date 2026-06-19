"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, Box, Library, CheckCircle, Clock, Settings, Menu, X, Plug, Plus, Search, LogOut, ChevronLeft, ChevronRight, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeModeButton } from "@/components/ThemeModeButton";
import { openCommandPalette } from "@/components/CommandPalette";
import { useApprovalsCount } from "@/lib/useApprovalsSync";
import { useQueryClient } from "@tanstack/react-query";
import { prefetchRouteData, prefetchIdleRoutes } from "@/lib/query/prefetch";
import { WorkspaceSwitcher } from "@/components/layout/WorkspaceSwitcher";
import { WorkspaceMonogram } from "@/components/layout/WorkspaceMonogram";
import { AlertsBell } from "@/components/overview/AlertsBell";
import { api } from "@/lib/api";
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "@/lib/safe-storage";
import { clearClientLogoutState } from "@/lib/auth/logout-cleanup";
import type { CurrentUser } from "@/lib/types";
import { resolveWorkspaceName } from "@/lib/workspace/display-name";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Exported so the Cloud wrapper's sidebar overlay can compose the engine's
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

// #1306 / G5: user profile avatar fallback when /me returns no OAuth photo.
// Flat squircle with plain initials: ink text on subtle bg, no gradient,
// no DiceBear network fetch. Matches design-system: squircle (radius-button),
// flat, no border, NO avatars/gradients.
function UserInitialsAvatar({ seed, size }: { seed: string; size: number }) {
  const initial = (seed || "U").trim()[0]?.toUpperCase() ?? "U";
  return (
    <span
      aria-hidden="true"
      className="shrink-0 inline-flex items-center justify-center rounded-[var(--radius-button)] bg-[var(--bg-2)] text-[var(--ink-soft)] font-medium select-none"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
    >
      {initial}
    </span>
  );
}

/** Active workspace name, resolved once from the workspace list (shared shape
 *  with UserProfileFooter so the mark + footer stay in sync). */
function useActiveWorkspaceName(): string {
  const [name, setName] = useState("");
  useEffect(() => {
    let active = true;
    api.workspace
      .list()
      .then((data) => {
        const current =
          data.workspaces.find((workspace) => workspace.id === data.active_id) ?? data.workspaces[0];
        if (active && current) setName(current.name);
      })
      .catch(() => {
        if (active) setName("");
      });
    return () => {
      active = false;
    };
  }, []);
  return name;
}

export function WorkspaceMark({
  size = 22,
  name,
  logoUrl,
}: {
  size?: number;
  name?: string;
  /** Real workspace logo (e.g. from the Cloud wrapper). When omitted, the OSS
   *  engine has no per-workspace logo, so a neutral monogram is shown. */
  logoUrl?: string | null;
}) {
  const fetched = useActiveWorkspaceName();
  const workspaceName = name ?? fetched;
  const [imgOk, setImgOk] = useState(true);
  const dim = { width: size, height: size } as const;

  if (logoUrl && imgOk) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={resolveWorkspaceName(workspaceName)}
        width={size}
        height={size}
        className="shrink-0 rounded-[var(--radius-button)] object-cover"
        style={dim}
        onError={() => setImgOk(false)}
      />
    );
  }
  // G3/G4: no avatars/DiceBear. Flat squircle monogram seeded by workspace
  // name — consistent with WorkspaceSwitcher mark and UserInitialsAvatar.
  return <WorkspaceMonogram name={workspaceName} size={size} />;
}

/** Mobile top-bar workspace name (white-label — replaces the "Floom" wordmark). */
function MobileWorkspaceName() {
  const name = useActiveWorkspaceName();
  return (
    <span className="font-semibold text-base tracking-tight truncate">
      {resolveWorkspaceName(name)}
    </span>
  );
}

// #1403: Secrets removed from top-level nav; reachable as a third tab on
// /connections ("Connected" / "Browse" / "Secrets"). Connections + secrets
// are the same mental model (credentials a worker can read) so they share
// a surface.
// `hint` is surfaced as a native title tooltip on hover — the flat single-row
// nav has no room for a permanent subtitle without a redesign, so the
// employee-model microcopy ("Workers run on triggers") lives in the tooltip
// instead (the operator 2026-06-02).
type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
  hint?: string;
  badge?: boolean;
};

// V4 SPEC §2: nav order per wireframe — no Assistant item (config lives in
// Settings per v4). Overview · Workers · Library · Runs · Approvals · Connections.
const nav: NavItem[] = [
  { href: "/overview", label: "Overview", icon: Activity },
  { href: "/workers", label: "Workers", icon: Box, hint: "Your AI workers" },
  { href: "/library", label: "Library", icon: Library },
  { href: "/runs", label: "Runs", icon: Clock },
  { href: "/approvals", label: "Approvals", icon: CheckCircle, badge: true },
  { href: "/connections", label: "Integrations", icon: Plug },
];

export function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  // Shared source with /approvals: revalidates on focus + after any
  // approve/reject so the badge never drifts from the list (G5 P2).
  const pendingCount = useApprovalsCount();
  // Data prefetch: warm the destination route's TanStack cache on hover/focus
  // so the tab switch is instant. Link already prefetches the route's JS/RSC;
  // this adds the DATA. Cache-first + idempotent (see prefetch.ts).
  const queryClient = useQueryClient();
  const router = useRouter();
  const warm = (href: string) => {
    prefetchRouteData(queryClient, href);
    router.prefetch(href);
  };

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
            prefetch
            onMouseEnter={() => warm(item.href)}
            onFocus={() => warm(item.href)}
            onClick={onNavigate}
            title={item.hint}
            className={cn(
              "flex h-9 items-center gap-2.5 rounded-[var(--radius-button)] px-2.5 text-sm font-medium transition-[background,color] duration-150 ease-[var(--ease)]",
              active
                ? "bg-[var(--active-nav-bg)] text-[var(--active-nav-text)] [&_svg]:text-[var(--active-nav-text)] [&_svg]:opacity-100"
                : "text-[var(--ink-soft)] hover:bg-[var(--active-nav-bg)] hover:text-ink [&_svg]:opacity-65"
            )}
          >
            <item.icon className="w-4 h-4" />
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
    <div className="px-3 pt-3 pb-3 space-y-1.5">
      {/* #902 (wireframe newbtn): creating a worker = a conversation with
          Emily — full-page chat in create mode, not a form. */}
      <Link
        href="/chat?mode=create"
        onClick={() => onNavigate?.()}
        className="flex h-9 w-full items-center justify-center gap-2 rounded-[var(--radius-button)] bg-[var(--primary)] px-3 text-sm font-medium text-[var(--primary-text)] transition-colors duration-150 hover:opacity-90"
      >
        <Plus className="w-4 h-4" />
        <span>New worker</span>
      </Link>
      {/* #1315: differentiated grey background (var(--bg-2)) so the Search box
          reads as an input, not a plain nav link. kbd chips sit on the lighter
          card surface so they stay legible against the grey field. */}
      <button
        type="button"
        onClick={onSearch}
        className="flex h-8 w-full items-center gap-2 rounded-[var(--radius-button)] [border:var(--bd-pill)] bg-[var(--bg-2)] px-2.5 text-sm text-[var(--ink-mute)] hover:bg-[var(--bg-3)] hover:text-ink transition-colors duration-150"
        aria-label="Open command palette"
      >
        <Search className="w-4 h-4 opacity-70" />
        <span>Search...</span>
        <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] tracking-widest text-[var(--ink-faint)]">
          <kbd className="rounded-[var(--radius-button)] [border:var(--bd-pill)] bg-[var(--bg-card)] px-1 py-0.5 text-[11px] leading-none font-sans" style={{ fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>⌘</kbd>
          <kbd className="rounded-[var(--radius-button)] [border:var(--bd-pill)] bg-[var(--bg-card)] px-1 py-0.5 font-mono">K</kbd>
        </span>
      </button>
    </div>
  );
}

// V4 SPEC §2: nav collapses to 62px icon rail via chevron in nav header.
// State is persisted to localStorage under "sidebar-collapsed" so it survives
// page navigations and refreshes.
const SIDEBAR_COLLAPSE_KEY = "sidebar-collapsed";

export type SidebarAccountFooterRenderProps = {
  onNavigate?: () => void;
};

export type SidebarProps = {
  accountFooter?: React.ReactNode | ((props: SidebarAccountFooterRenderProps) => React.ReactNode);
};

function renderAccountFooter(
  accountFooter: SidebarProps["accountFooter"],
  props: SidebarAccountFooterRenderProps = {}
) {
  if (typeof accountFooter === "function") return accountFooter(props);
  return accountFooter ?? <UserProfileFooter onNavigate={props.onNavigate} />;
}

export function Sidebar({ accountFooter }: SidebarProps = {}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // collapsed = icon-rail (62px); expanded = full (228px)
  const [collapsed, setCollapsed] = useState(false);

  // Hydrate from localStorage after mount to avoid SSR mismatch
  useEffect(() => {
    if (safeStorageGet("local", SIDEBAR_COLLAPSE_KEY) === "1") setCollapsed(true);
  }, []);

  const toggleCollapse = () => {
    setCollapsed((prev) => {
      const next = !prev;
      if (next) {
        safeStorageSet("local", SIDEBAR_COLLAPSE_KEY, "1");
      } else {
        safeStorageRemove("local", SIDEBAR_COLLAPSE_KEY);
      }
      return next;
    });
  };

  // Close mobile nav on route changes
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const pendingCount = useApprovalsCount();
  // Data prefetch (collapsed icon rail uses this `warm`; the expanded nav warms
  // inside NavLinks). After first paint, warm the highest-value routes once on
  // idle so the first tab switch is already instant.
  const queryClient = useQueryClient();
  const router = useRouter();
  const warm = (href: string) => {
    prefetchRouteData(queryClient, href);
    router.prefetch(href);
  };
  useEffect(() => {
    prefetchIdleRoutes(queryClient, pathname);
    // Run once after mount; pathname/queryClient are stable enough for a
    // one-shot idle warm (re-running on every nav would be a refetch storm).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {/* ── Mobile top bar ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between [border-bottom:var(--bd-div)] bg-[var(--bg-app)] px-4 md:hidden">
        {/* #1305: white-label — workspace mark + name, not the Floom brand. */}
        <Link href="/overview" className="flex items-center gap-2 min-w-0">
          <WorkspaceMark size={22} />
          <MobileWorkspaceName />
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
          {/* #1292: global alerts bell on mobile (AppShell's pane-anchored bell
              is desktop-only). Self-fetches needs-attention; dropdown opens
              below-right of the trigger. */}
          <AlertsBell />
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

      {/* ── Desktop sidebar ─────────────────────────────────────────────────── */}
      <aside
        className={cn(
          "sticky top-0 z-20 hidden h-screen flex-col [border-right:var(--bd-div)] bg-[var(--bg-app)] transition-[width] duration-200 md:flex overflow-hidden",
          collapsed ? "w-[62px]" : "w-[228px]"
        )}
        aria-label="Main navigation"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-card/70 dark:bg-card/[0.055]" aria-hidden="true" />

        {/* ── Nav header: workspace identity + collapse chevron ─────────────── */}
        <div className={cn("flex items-center [border-bottom:var(--bd-div)]", collapsed ? "justify-center h-14 px-0" : "h-14 gap-1.5 px-3")}>
          {collapsed ? (
            /* Icon-rail: just the mark, clicking expands */
              <button
                type="button"
                aria-label="Expand navigation"
                aria-expanded="false"
                aria-pressed={collapsed}
                onClick={toggleCollapse}
                className="inline-flex size-9 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-soft)] hover:bg-[var(--active-nav-bg)] hover:text-ink"
              >
              {/* #1305: white-label — workspace mark, not the Floom brand. */}
              <WorkspaceMark size={22} />
            </button>
          ) : (
            <>
              {/* #1305: white-label — the WorkspaceSwitcher already renders the
                  workspace mark + name as the top-left identity, so no separate
                  Floom brand mark here (it would be a redundant second mark and
                  leaks the Floom brand into a white-labeled app). */}
              <div className="min-w-0 flex-1">
                <WorkspaceSwitcher />
              </div>
              {/* Collapse chevron — dim at rest, full opacity on hover */}
              <button
                type="button"
                aria-label="Collapse navigation"
                aria-expanded="true"
                aria-pressed={collapsed}
                onClick={toggleCollapse}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-soft)] opacity-40 hover:opacity-100 focus-visible:opacity-100 transition-all hover:bg-[var(--active-nav-bg)] hover:text-ink"
                title="Collapse sidebar"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </>
          )}
        </div>

        {!collapsed && (
          <>
            <SidebarPrimaryActions />
            <NavLinks pathname={pathname} />
            {renderAccountFooter(accountFooter)}
          </>
        )}

        {/* ── Icon rail (collapsed) ─────────────────────────────────────────── */}
        {collapsed && (
          <nav className="flex flex-1 flex-col items-center gap-0.5 pt-3 pb-3 overflow-y-auto" aria-label="Icon navigation">
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
                  prefetch
                  onMouseEnter={() => warm(item.href)}
                  onFocus={() => warm(item.href)}
                  title={item.label}
                  className={cn(
                    "relative inline-flex size-9 items-center justify-center rounded-[var(--radius-button)] transition-[background,color] duration-150",
                    active
                      ? "bg-[var(--active-nav-bg)] text-[var(--active-nav-text)]"
                      : "text-[var(--ink-soft)] hover:bg-[var(--active-nav-bg)] hover:text-ink"
                  )}
                >
                  <item.icon className="w-4 h-4" />
                  {showBadge && (
                    <span className="absolute -top-0.5 -right-0.5 size-3.5 rounded-[var(--radius-pill)] bg-[var(--primary)] flex items-center justify-center text-[8px] font-bold text-[var(--primary-text)]">
                      {pendingCount > 9 ? "9+" : pendingCount}
                    </span>
                  )}
                </Link>
              );
            })}
            {/* Settings icon at bottom */}
            <div className="flex-1" />
            <Link
              href="/settings"
              title="Settings"
              className={cn(
                "inline-flex size-9 items-center justify-center rounded-[var(--radius-button)] transition-[background,color] duration-150",
                pathname === "/settings" || pathname.startsWith("/settings/")
                  ? "bg-[var(--active-nav-bg)] text-[var(--active-nav-text)]"
                  : "text-[var(--ink-soft)] hover:bg-[var(--active-nav-bg)] hover:text-ink"
              )}
            >
              <Settings className="w-4 h-4" />
            </Link>
            {/* Expand chevron at the very bottom */}
            <button
              type="button"
              aria-label="Expand navigation"
              aria-expanded="false"
              aria-pressed={collapsed}
              onClick={toggleCollapse}
              title="Expand sidebar"
              className="inline-flex size-9 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-soft)] hover:bg-[var(--active-nav-bg)] hover:text-ink transition-colors mt-1"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </nav>
        )}
      </aside>

      {/* ── Mobile drawer ───────────────────────────────────────────────────── */}
      {open && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-50 flex h-full w-64 max-w-[80vw] flex-col [border-right:var(--bd-div)] bg-[var(--bg-app)] shadow-pop">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-card/70 dark:bg-card/[0.055]" aria-hidden="true" />
            <div className="flex items-center justify-between [border-bottom:var(--bd-div)] px-3 py-2">
              <div className="flex-1 min-w-0">
                <WorkspaceSwitcher />
              </div>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setOpen(false)}
                className="ml-1 inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-ink"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="py-3 flex-1 overflow-auto">
              <SidebarPrimaryActions onNavigate={() => setOpen(false)} />
              <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
            </div>
            {renderAccountFooter(accountFooter, { onNavigate: () => setOpen(false) })}
          </aside>
        </div>
      )}
    </>
  );
}

// S29b: replaces the "Floom v0" bottom-left footer with a user profile chip.
// Today's single-user v0 shows "Local user"; the cloud build (see
// docs/architecture/supabase-cloud-wiring-brief.md) will swap this for the
// signed-in Supabase user's email + avatar.
//
// V8 (the operator 2026-06-02): "have settings next to name, as the gear icon, not
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
  const router = useRouter();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [workspaceName, setWorkspaceName] = useState("Floom workspace");

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

  useEffect(() => {
    let active = true;
    api.workspace
      .list()
      .then((data) => {
        const current = data.workspaces.find((workspace) => workspace.id === data.active_id) ?? data.workspaces[0];
        if (active && current) setWorkspaceName(resolveWorkspaceName(current.name));
      })
      .catch(() => {
        if (active) setWorkspaceName("Floom workspace");
      });
    return () => {
      active = false;
    };
  }, []);

  // Multi-member: prefer username, then email, then display_name
  const primary = (user as (typeof user & { username?: string | null }) | null)?.username
    || user?.email || user?.display_name || "Local user";
  const secondary = workspaceName;
  // #1306: prefer the explicit prop, else the OAuth photo off the fetched user
  // (Google/GitHub `picture` / `avatar_url`). OSS /me returns neither, so this
  // gracefully falls back to initials; the Cloud wrapper's /me supplies it.
  const photoUrl =
    avatarUrl
    ?? (user as (CurrentUser & { picture?: string | null; avatar_url?: string | null }) | null)?.picture
    ?? user?.avatar_url
    ?? null;

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Clearing the cookie is best-effort; navigate regardless.
    }
    clearClientLogoutState();
    onNavigate?.();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2 [border-top:var(--bd-div)] px-3 py-3">
      {/* Profile chip — clicking opens a dropdown with Settings + Sign out (M37). */}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex items-center gap-2 min-w-0 flex-1 rounded-[var(--radius-button)] px-1 py-0.5 -mx-1 transition-[background,color] duration-150 ease-[var(--ease)]",
            "hover:bg-[var(--active-nav-bg)] focus:outline-none"
          )}
          aria-label="Profile menu"
        >
          {/* #1306 / M36: profile photo (Google/GitHub) when available, else
              initials. Squared (rounded-square via the app radius token), no
              border. */}
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoUrl}
              alt="Profile avatar"
              className="size-7 shrink-0 rounded-[var(--radius-button)] border-0 object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            // #1306: no OAuth photo (OSS /me returns none): fall back to a
            // DiceBear avatar deterministically seeded by the user's
            // email/name, NOT bare initials. Squircle container, no border,
            // matching the workspace mark approach.
            <UserInitialsAvatar seed={primary} size={28} />
          )}
          <div className="min-w-0 leading-tight text-left">
            <p className="text-xs font-medium text-foreground truncate">{primary}</p>
            <p className="text-[10px] text-muted-foreground truncate">{secondary}</p>
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-48 p-1">
          <DropdownMenuItem
            render={<Link href="/settings?sel=profile" onClick={onNavigate} />}
            className="flex items-center gap-2 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
          >
            <UserRound className="size-4" />
            Edit profile
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link href="/settings" onClick={onNavigate} />}
            className="flex items-center gap-2 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
          >
            <Settings className="size-4" />
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
