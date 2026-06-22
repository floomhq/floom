"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Library, CheckCircle, Clock, Settings, Menu, X, Plug, Plus, Search, LogOut, ChevronLeft, ChevronRight, UserRound, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ThemeModeButton } from "@/components/ThemeModeButton";
import { openCommandPalette } from "@/components/CommandPalette";
import { useMcpModal } from "@/components/mcp/mcp-modal-context";
import { useApprovalsCount } from "@/lib/useApprovalsSync";
import { useNavBadgeCounts } from "@/lib/useSelfOverviewItems";
import { useQueryClient } from "@tanstack/react-query";
import { prefetchRouteData, prefetchIdleRoutes } from "@/lib/query/prefetch";
import { WorkspaceSwitcher } from "@/components/layout/WorkspaceSwitcher";
import { api } from "@/lib/api";
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "@/lib/safe-storage";
import { clearClientLogoutState } from "@/lib/auth/logout-cleanup";
import type { CurrentUser } from "@/lib/types";
import { resolveWorkspaceName, resolveUserLabel } from "@/lib/workspace/display-name";
import { GenerativeAvatar } from "@/components/GenerativeAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Exported so the Downstream host's sidebar overlay can compose the engine's
// brand mark + nav + primary actions and only add its account/workspace
// footer, keeping the dashboard UI in sync with the engine (no fork).
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

// #1305: the app is WHITE-LABELED — the workspace IS the brand. The mark must
// be the WORKSPACE logo/avatar, never the Floom play-triangle.
// Generative avatar deterministically seeded by workspace name — squircle shape.
function WorkspaceDiceBearAvatar({ name, size }: { name: string; size: number }) {
  const seed = resolveWorkspaceName(name) || name || "workspace";
  return <GenerativeAvatar seed={seed} shape="squircle" size={size} />;
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
  /** Real workspace logo (e.g. from the Downstream host). When omitted, the OSS
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
  // DiceBear shapes avatar — consistent with the WorkspaceSwitcher mark.
  return <WorkspaceDiceBearAvatar name={workspaceName} size={size} />;
}

/** Mobile top-bar workspace name (white-label, replaces the "Floom" wordmark). */
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
// `hint` is surfaced as a native title tooltip on hover, the flat single-row
// nav has no room for a permanent subtitle without a redesign, so the
// employee-model microcopy ("Workers run on triggers") lives in the tooltip
// instead (the operator 2026-06-02).
// Each badge is sourced from one shared, polled fetch (see below):
//  - approvals  → pending-approvals count   (neutral tone)
//  - connections → connections needing re-auth / expired (amber attention)
//  - runs       → recent failed runs        (amber attention)
type NavBadgeKey = "approvals" | "connections" | "runs";

type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
  hint?: string;
  badge?: NavBadgeKey;
};

// Emily-home redesign (Federico 2026-06-19): the "Overview" nav item is gone,
// the home ("/") is now the Emily-fullscreen home, reached via the workspace
// logo/switcher, not a nav row. Nav: Workers · Library · Runs · Approvals ·
// Connections. (MCP is a pinned item above the profile footer, see below.)
const nav: NavItem[] = [
  { href: "/workers", label: "Workers", icon: Box, hint: "Your AI workers" },
  { href: "/library", label: "Library", icon: Library },
  { href: "/runs", label: "Runs", icon: Clock, badge: "runs" },
  { href: "/approvals", label: "Approvals", icon: CheckCircle, badge: "approvals" },
  { href: "/connections", label: "Connections", icon: Plug, badge: "connections" },
];

// Subtle amber attention treatment (Floom DS: red is NOT a Floom color — amber
// #C98A1A == var(--warning)). Mirrors the .c-pill.err token in globals.css.
const AMBER_BADGE_CLASS =
  "bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[color-mix(in_srgb,var(--warning)_82%,var(--ink))]";

/** Resolve a nav item's badge count + tone from the shared badge sources.
 *  Pure helper (no hooks) so it is safe to call inside the nav .map(). */
function resolveNavBadge(key: NavBadgeKey | undefined, counts: NavBadgeCounts) {
  if (!key) return null;
  if (key === "approvals") {
    return counts.pendingApprovals > 0
      ? { count: counts.pendingApprovals, tone: "neutral" as const }
      : null;
  }
  if (key === "connections") {
    return counts.connectionsExpired > 0
      ? { count: counts.connectionsExpired, tone: "amber" as const }
      : null;
  }
  return counts.failedRuns > 0
    ? { count: counts.failedRuns, tone: "amber" as const }
    : null;
}

type NavBadgeCounts = {
  pendingApprovals: number;
  connectionsExpired: number;
  failedRuns: number;
};

/** Pull all three badge counts from one shared overview fetch + the shared
 *  approvals source. Used by both the expanded nav and the collapsed rail. */
function useNavBadgeSources(): NavBadgeCounts {
  const pendingApprovals = useApprovalsCount();
  const { connectionsExpired, failedRuns } = useNavBadgeCounts();
  return { pendingApprovals, connectionsExpired, failedRuns };
}

export function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  // Badge counts from one shared, polled overview fetch (+ the shared approvals
  // source, which revalidates on focus + after any approve/reject — G5 P2).
  const badgeCounts = useNavBadgeSources();
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
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        const badge = resolveNavBadge(item.badge, badgeCounts);
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
            {badge && (
              <Badge
                variant={badge.tone === "amber" ? "default" : "secondary"}
                aria-hidden="true"
                className={cn(
                  "ml-auto h-4 min-w-4 px-1 text-[10px] font-semibold leading-none tabular-nums",
                  badge.tone === "amber" && AMBER_BADGE_CLASS,
                )}
              >
                {badge.count > 99 ? "99+" : badge.count}
              </Badge>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

// MCP item, pinned LOW, just above the profile footer (Emily-home redesign).
// Opens the MCP-install POPUP modal (not a page). The badge mirrors the v6
// "12" affordance but is informational chrome only; the count is omitted here
// since the OSS engine has no live "installed clients" count to show honestly.
function SidebarMcpItem({ onNavigate }: { onNavigate?: () => void }) {
  const mcpModal = useMcpModal();
  return (
    <div className="px-3 pb-2">
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          mcpModal.open();
        }}
        title="Add Floom to your AI client"
        className="flex h-9 w-full items-center gap-2.5 rounded-[var(--radius-button)] px-2.5 text-sm font-medium text-[var(--ink-soft)] transition-[background,color] duration-150 ease-[var(--ease)] hover:bg-[var(--active-nav-bg)] hover:text-ink [&_svg]:opacity-65"
      >
        <Terminal className="w-4 h-4" />
        MCP
      </button>
    </div>
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
          Emily. Federico 2026-06-19: it is the SAME fullscreen Emily as the home
          (the dock-fullscreen surface), primed for create via `/?create=1`, not a
          separate full-page chat with its own header. */}
      {/* Global primary CTA: canonical Button (size lg = h-9) rendered as the
          create-worker Link. Same primary token + label everywhere. */}
      <Link
        href="/?create=1"
        onClick={() => onNavigate?.()}
        className={cn(buttonVariants({ size: "lg" }), "w-full")}
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

  const badgeCounts = useNavBadgeSources();
  const mcpModal = useMcpModal();
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
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between [border-bottom:var(--bd-div)] bg-[var(--bg-app)] px-4 lg:hidden">
        {/* #1305: white-label, workspace mark + name, not the Floom brand. */}
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
          "sticky top-0 z-20 hidden h-screen flex-col [border-right:var(--bd-div)] bg-[var(--bg-app)] transition-[width] duration-200 lg:flex overflow-hidden",
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
              {/* #1305: white-label, workspace mark, not the Floom brand. */}
              <WorkspaceMark size={22} />
            </button>
          ) : (
            <>
              {/* #1305: white-label, the WorkspaceSwitcher already renders the
                  workspace mark + name as the top-left identity, so no separate
                  Floom brand mark here (it would be a redundant second mark and
                  leaks the Floom brand into a white-labeled app). */}
              <div className="min-w-0 flex-1">
                <WorkspaceSwitcher />
              </div>
              {/* Collapse chevron, dim at rest, full opacity on hover */}
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
            <SidebarMcpItem />
            {renderAccountFooter(accountFooter)}
          </>
        )}

        {/* ── Icon rail (collapsed) ─────────────────────────────────────────── */}
        {collapsed && (
          <nav className="flex flex-1 flex-col items-center gap-0.5 pt-3 pb-3 overflow-y-auto" aria-label="Icon navigation">
            {nav.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              const badge = resolveNavBadge(item.badge, badgeCounts);
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
                  {badge && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute -top-0.5 -right-0.5 size-3.5 rounded-[var(--radius-pill)] flex items-center justify-center text-[8px] font-bold",
                        badge.tone === "amber"
                          ? AMBER_BADGE_CLASS
                          : "bg-[var(--bg-2)] text-[var(--ink-soft)]",
                      )}
                    >
                      {badge.count > 9 ? "9+" : badge.count}
                    </span>
                  )}
                </Link>
              );
            })}
            {/* Settings icon at bottom */}
            <div className="flex-1" />
            {/* MCP, opens the install popup modal (above Settings). */}
            <button
              type="button"
              onClick={() => mcpModal.open()}
              title="MCP, add Floom to your AI client"
              aria-label="MCP, add Floom to your AI client"
              className="inline-flex size-9 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-soft)] transition-[background,color] duration-150 hover:bg-[var(--active-nav-bg)] hover:text-ink"
            >
              <Terminal className="w-4 h-4" />
            </button>
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
        <div className="lg:hidden fixed inset-0 z-40 flex">
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
            <SidebarMcpItem onNavigate={() => setOpen(false)} />
            {renderAccountFooter(accountFooter, { onNavigate: () => setOpen(false) })}
          </aside>
        </div>
      )}
    </>
  );
}

// S29b: replaces the "Floom v0" bottom-left footer with a user profile chip.
// Today's single-user v0 shows "Local user"; hosted builds can swap this for
// the signed-in user's email + avatar.
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
  // #1709: canonical fallback is "My workspace" (resolveWorkspaceName), NOT the
  // brand-specific "Floom workspace" — the app is white-labeled and the OSS /me
  // has no workspace yet on first paint.
  const [workspaceName, setWorkspaceName] = useState("My workspace");

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
        if (active) setWorkspaceName("My workspace");
      });
    return () => {
      active = false;
    };
  }, []);

  // Multi-member: prefer username, then email, then display_name. #1728: skip
  // UUID-shaped candidates so a raw user/owner id never leaks as the identity
  // line (the OSS /me can return an id-only username).
  const primary = resolveUserLabel(
    [
      (user as (typeof user & { username?: string | null }) | null)?.username,
      user?.email,
      user?.display_name,
    ],
    "Local user",
  );
  const secondary = workspaceName;
  // #1306: prefer the explicit prop, else the OAuth photo off the fetched user
  // (Google/GitHub `picture` / `avatar_url`). OSS /me returns neither, so this
  // gracefully falls back to initials; the Downstream host's /me supplies it.
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
      {/* Profile chip, clicking opens a dropdown with Settings + Sign out (M37). */}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex items-center gap-2 min-w-0 flex-1 rounded-[var(--radius-button)] px-1 py-0.5 -mx-1 transition-[background,color] duration-150 ease-[var(--ease)]",
            "hover:bg-[var(--active-nav-bg)] focus:outline-none"
          )}
          aria-label="Profile menu"
        >
          {/* #1306 / M36: profile photo (Google/GitHub) beats generated default.
              GenerativeAvatar handles the override ladder: avatarUrl present
              → real photo cropped to circle; absent → generative default. */}
          <GenerativeAvatar
            seed={primary}
            shape="circle"
            size={28}
            avatarUrl={photoUrl}
            alt="Profile avatar"
          />
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
