"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogOut, Settings } from "lucide-react";

import { ThemeModeButton } from "@/components/ThemeModeButton";
import type { CurrentUser } from "@/lib/types";
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

function profileInitials(value: string) {
  const local = value.includes("@") ? value.split("@", 1)[0] : value;
  const parts = local
    .split(/[\s._-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const letters = parts.length > 1 ? [parts[0][0], parts[1][0]] : [local[0], local[1]];
  return (
    letters
      .filter(Boolean)
      .join("")
      .toUpperCase() || "LU"
  );
}

export function CloudAccountFooter({ onNavigate }: { onNavigate?: () => void } = {}) {
  const pathname = usePathname();
  const settingsActive = pathname === "/settings" || pathname.startsWith("/settings/");
  const isLoginPath =
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/app/login" ||
    pathname.startsWith("/app/login/");
  const [user, setUser] = useState<CurrentUser | null>(null);

  useEffect(() => {
    if (isLoginPath) return;
    let cancelled = false;
    fetch("/app/api/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && data?.user?.email) {
          setUser(data.user as CurrentUser);
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
    ? user?.email || "Signed in"
    : user?.email
      ? "Signed in"
      : "Floom";
  const initial = profileInitials(primary);

  async function logout() {
    try {
      await fetch("/app/api/proxy/auth/logout", { method: "POST" });
    } catch {
      // Cookie clearing is best effort; navigate regardless.
    }
    onNavigate?.();
    window.location.replace("/app/login?next=/app");
  }

  return (
    <div className="flex items-center gap-2 [border-top:var(--bd-div)] px-3 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="grid size-7 shrink-0 place-items-center rounded-full border border-[var(--border-soft)] bg-muted text-[11px] font-medium text-foreground">
          {initial}
        </div>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-xs font-medium text-foreground">{primary}</p>
          <p className="truncate text-[10px] text-muted-foreground">{secondary}</p>
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
