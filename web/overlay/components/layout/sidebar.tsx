"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X, Search, Settings, LogOut, Plus } from "lucide-react";
import { ThemeModeButton } from "@/components/ThemeModeButton";
import { openCommandPalette } from "@/components/CommandPalette";
import { WorkspaceSwitcher } from "@/components/layout/WorkspaceSwitcher";
import type { CurrentUser } from "@/lib/types";
// Compose the engine's brand mark + nav + primary actions from the SYNCED
// engine sidebar (Phase 1 seam: those parts are exported there). This keeps
// the Cloud dashboard's nav (order, icons, Approvals badge, active-state
// styling) byte-identical to the engine — no fork. The ONLY things this
// overlay adds on top are the Cloud account footer (signed-in Supabase user +
// sign-out) and the <WorkspaceSwitcher/>; everything else is the engine shell.
import {
  FloomMark,
  NavLinks,
} from "@/components/layout/sidebar.engine";

// Cloud override of SidebarPrimaryActions: platform-aware keyboard shortcut label.
function SidebarPrimaryActions({ onNavigate }: { onNavigate?: () => void }) {
  const [isMac, setIsMac] = useState(true);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform ?? navigator.userAgent));
  }, []);
  const onSearch = () => { onNavigate?.(); openCommandPalette(); };
  return (
    <div className="px-3 pb-3 space-y-1.5">
      <Link
        href="/chat?mode=create"
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
          <kbd className="rounded border border-[var(--border-soft)] bg-[var(--bg-2)] px-1 py-0.5 text-[11px] leading-none font-sans" style={{ fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>
            {isMac ? "⌘" : "Ctrl"}
          </kbd>
          <kbd className="rounded border border-[var(--border-soft)] bg-[var(--bg-2)] px-1 py-0.5 font-mono">K</kbd>
        </span>
      </button>
    </div>
  );
}

export { FloomMark };
import { cn } from "@/lib/utils";

const ACTIVE_WORKSPACE_STORAGE_KEY = "workeros.activeWorkspaceId";

function activeWorkspaceHeaders(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  if (typeof window === "undefined") return next;
  const workspaceId = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  if (workspaceId && workspaceId !== "local-default") {
    next.set("x-workeros-workspace", workspaceId);
  }
  return next;
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
          <FloomMark size={22} />
          <span className="font-semibold text-base tracking-tight">Floom</span>
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

      <aside className="sticky top-0 z-20 hidden h-screen w-60 flex-col border-r border-[var(--border-soft)] bg-[var(--bg-app)] md:flex">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-card/70 dark:bg-card/[0.055]" aria-hidden="true" />
        <div className="px-5 pt-6 pb-8">
          <Link href="/" className="flex items-center gap-2">
            <FloomMark size={22} />
            <span className="font-semibold text-base tracking-tight">Floom</span>
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
              <Link href="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
                <FloomMark size={22} />
                <span className="font-semibold text-base tracking-tight">Floom</span>
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

// Cloud build: reads the signed-in Supabase user from /api/me (which
// decodes the workeros_cloud_session cookie set by the cloud backend's
// /auth/callback) and shows email + initial. Logout posts to the cloud
// backend's /auth/logout (through the proxy) and bounces back to /login.
//
// V8 (Federico 2026-06-02, engine ef0ef36): Settings is a small gear-icon
// button inline on the name row, NOT a separate full-width SidebarSettingsLink.
// Sign-out is a LogOut icon button next to the gear — IDENTICAL to the engine
// UserProfileFooter's icon/size/placement/aria treatment (Federico 2026-06-03:
// visual parity, drop the text link + confirm dialog). The ONLY Cloud seams are
// the Supabase account email/initial display and the logout POST target
// (cloud proxy path) + post-logout bounce to /app/login.
function UserProfileFooter({ onNavigate }: { onNavigate?: () => void } = {}) {
  const pathname = usePathname();
  const settingsActive = pathname === "/settings" || pathname.startsWith("/settings/");
  const isLoginPath = pathname === "/login" || pathname.startsWith("/login/") || pathname === "/app/login" || pathname.startsWith("/app/login/");
  const [user, setUser] = useState<CurrentUser | null>(null);
  useEffect(() => {
    if (isLoginPath) return;
    let cancelled = false;
    fetch("/app/api/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d?.user?.email) {
          setUser(d.user as CurrentUser);
          // Ensure the user has at least one PAT (fire-and-forget).
          // bootstrap is idempotent — no-ops if a token already exists.
          fetch("/app/api/proxy/auth/tokens/bootstrap", {
            method: "POST",
            headers: activeWorkspaceHeaders(),
          }).catch(() => {});
        } else if (!cancelled) {
          window.location.replace("/app/login?next=/app");
        }
      })
      .catch(() => {
        if (!cancelled) window.location.replace("/app/login?next=/app");
      });
    return () => {
      cancelled = true;
    };
  }, [isLoginPath]);
  if (isLoginPath) return null;
  const primary = user?.display_name?.trim() || user?.email || "Local user";
  const secondary = user?.display_name?.trim()
    ? (user?.email || "Signed in")
    : (user?.email ? "Signed in" : "WorkerOS");
  const initial = profileInitials(primary);

  async function logout() {
    try {
      await fetch("/app/api/proxy/auth/logout", { method: "POST" });
    } catch {
      // Clearing the cookie is best-effort; navigate regardless.
    }
    onNavigate?.();
    window.location.replace("/app/login?next=/app");
  }

  return (
    <div className="flex items-center gap-2 border-t border-[var(--border-soft)] px-3 py-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="size-7 shrink-0 rounded-full bg-muted text-foreground border border-[var(--border-soft)] grid place-items-center text-[11px] font-medium">
          {initial}
        </div>
        <div className="min-w-0 leading-tight">
          <p className="text-xs font-medium text-foreground truncate">
            {primary}
          </p>
          <p className="text-[10px] text-muted-foreground truncate">
            {secondary}
          </p>
        </div>
      </div>
      <Link
        href="/settings"
        onClick={onNavigate}
        aria-label="Settings"
        title="Settings"
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] transition-[background,color] duration-150 ease-[var(--ease)]",
          settingsActive
            ? "bg-[var(--active-nav-bg)] text-[var(--active-nav-text)]"
            : "text-[var(--ink-soft)] hover:bg-[var(--active-nav-bg)] hover:text-ink"
        )}
      >
        <Settings className="size-4" />
      </Link>
      <button
        type="button"
        onClick={logout}
        aria-label="Sign out"
        title="Sign out"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-soft)] transition-[background,color] duration-150 ease-[var(--ease)] hover:bg-[var(--active-nav-bg)] hover:text-ink"
      >
        <LogOut className="size-4" />
      </button>
      <ThemeModeButton />
    </div>
  );
}
