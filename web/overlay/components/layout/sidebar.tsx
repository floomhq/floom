"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X, Search } from "lucide-react";
import { ThemeModeButton } from "@/components/ThemeModeButton";
import { openCommandPalette } from "@/components/CommandPalette";
import { WorkspaceSwitcher } from "@/components/layout/WorkspaceSwitcher";
// Compose the engine's brand mark + nav + primary actions from the SYNCED
// engine sidebar (Phase 1 seam: those parts are exported there). This keeps
// the Cloud dashboard's nav (order, icons, Approvals badge, active-state
// styling) byte-identical to the engine — no fork. The ONLY things this
// overlay adds on top are the Cloud account footer (signed-in Supabase user +
// sign-out) and the <WorkspaceSwitcher/>; everything else is the engine shell.
import {
  FloomMark,
  NavLinks,
  SidebarPrimaryActions,
} from "@/components/layout/sidebar.engine";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
// backend's /auth/logout (through the proxy) and bounces back to /login.
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
      // Redirect to /app — the middleware runs server-side and has access to
      // WORKEROS_API_BASE, so it will immediately redirect unauthenticated
      // visitors to the backend's /auth/login?provider=google OAuth URL.
      // This avoids needing a NEXT_PUBLIC_ env var here.
      window.location.href = "/app";
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--border-soft)] px-3 py-3">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="size-7 shrink-0 rounded-full bg-muted text-foreground border border-[var(--border-soft)] grid place-items-center text-[11px] font-medium">
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
