"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, Box, Clock, Settings, Menu, X, Plug, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeModeButton } from "@/components/ThemeModeButton";
import { openCommandPalette } from "@/components/CommandPalette";
import { WorkspaceSwitcher } from "@/components/layout/WorkspaceSwitcher";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
      <rect width="100" height="100" rx="22" fill="#1a1a1a" />
      <path
        d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
        fill="#FAFAF7"
      />
    </svg>
  );
}

// S24: Secrets removed from top-level nav; reachable as a third tab on
// /connections ("Connected" / "Browse" / "Secrets"). Connections + secrets
// are the same mental model (credentials a worker can read) so they share
// a surface.
const nav = [
  { href: "/", label: "Overview", icon: Activity },
  { href: "/workers", label: "Workers", icon: Box },
  { href: "/runs", label: "Runs", icon: Clock },
  { href: "/connections", label: "Connections", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex-1 px-3 space-y-0.5">
      {nav.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex h-9 items-center gap-2.5 rounded-md border px-2.5 text-sm font-medium transition-[background,border-color,color] duration-150 ease-[var(--ease)]",
              active
                ? "border-[color-mix(in_srgb,var(--accent)_18%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-ink shadow-none [&_svg]:text-[var(--accent)] [&_svg]:opacity-100"
                : "border-transparent text-[var(--ink-soft)] hover:bg-[color-mix(in_srgb,var(--paper)_62%,transparent)] hover:text-ink [&_svg]:opacity-65"
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
        className="flex h-9 items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 text-sm font-medium text-[var(--solid-fg)] shadow-[var(--shadow-btn)] hover:bg-[var(--solid-2)] transition-colors duration-150"
      >
        <Plus className="w-4 h-4" />
        New worker
      </Link>
      <button
        type="button"
        onClick={onSearch}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-line bg-transparent px-2.5 text-sm text-[var(--ink-mute)] hover:bg-[color-mix(in_srgb,var(--paper)_62%,transparent)] hover:text-ink transition-colors duration-150"
        aria-label="Open command palette"
      >
        <Search className="w-4 h-4 opacity-70" />
        <span>Search...</span>
        <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] tracking-widest text-[var(--ink-faint)]">
          <kbd className="rounded border border-line bg-[var(--bg-2)] px-1 py-0.5 text-[11px] leading-none font-sans" style={{ fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }}>⌘</kbd>
          <kbd className="rounded border border-line bg-[var(--bg-2)] px-1 py-0.5 font-mono">K</kbd>
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
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-[var(--sidebar-glass)] px-4 shadow-[var(--sidebar-glass-shadow)] backdrop-blur-[14px] backdrop-saturate-[140%] md:hidden">
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

      <aside className="sticky top-0 z-20 hidden h-screen w-60 flex-col border-r border-line bg-[var(--sidebar-glass)] shadow-[var(--sidebar-glass-shadow)] backdrop-blur-[14px] backdrop-saturate-[140%] md:flex">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-card/70 dark:bg-card/[0.055]" aria-hidden="true" />
        <div className="px-5 py-5">
          <Link href="/" className="flex items-center gap-2">
            <FloomMark size={28} />
            <span className="font-semibold text-[15px] tracking-tight">Floom</span>
          </Link>
        </div>
        <SidebarPrimaryActions />
        <NavLinks pathname={pathname} />
        <div className="mt-auto pt-3 border-t border-line">
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
          <aside className="relative z-50 flex h-full w-64 max-w-[80vw] flex-col border-r border-line bg-[var(--sidebar-glass)] shadow-pop backdrop-blur-[14px] backdrop-saturate-[140%]">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-card/70 dark:bg-card/[0.055]" aria-hidden="true" />
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
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
            <div className="pt-3 border-t border-line">
              <WorkspaceSwitcher />
            </div>
            <UserProfileFooter />
          </aside>
        </div>
      )}
    </>
  );
}

// Cloud build: reads the signed-in Supabase user from /api/me (which
// decodes the workeros_cloud_session cookie set by the cloud backend's
// /auth/callback) and shows email + initial. Logout posts to the cloud
// backend's /auth/logout and bounces back to /.
function UserProfileFooter() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/app/api/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d?.user?.email) setEmail(d.user.email as string);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const initial = email
    ? email.split("@")[0]?.slice(0, 2).toUpperCase() ?? "??"
    : "—";
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const confirmSignOut = async () => {
    setSigningOut(true);
    try {
      await fetch("/app/api/proxy/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="size-7 shrink-0 rounded-full bg-muted text-foreground border border-line grid place-items-center text-[11px] font-medium">
          {initial}
        </div>
        <div className="min-w-0 leading-tight">
          <p className="text-xs font-medium text-foreground truncate">
            {email ?? "—"}
          </p>
          <button
            type="button"
            onClick={() => setSignOutOpen(true)}
            className="text-[10px] text-muted-foreground hover:text-foreground truncate"
          >
            Sign out
          </button>
        </div>
      </div>
      <ThemeModeButton />
      <SignOutDialog
        open={signOutOpen}
        onOpenChange={setSignOutOpen}
        onConfirm={confirmSignOut}
        loading={signingOut}
        email={email}
      />
    </div>
  );
}

function SignOutDialog({
  open,
  onOpenChange,
  onConfirm,
  loading,
  email,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onConfirm: () => void | Promise<void>;
  loading: boolean;
  email: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>Sign out?</DialogTitle>
          <DialogDescription>
            You will be signed out of {email ?? "this account"} and returned to the sign-in page.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 items-center justify-center rounded-md border border-line bg-card px-4 text-sm font-medium hover:bg-muted transition-colors"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={loading}
            className="inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90 disabled:opacity-60 transition-opacity"
          >
            {loading ? "Signing out…" : "Sign out"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
