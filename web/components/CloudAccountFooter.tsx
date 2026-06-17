"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogOut, Settings } from "lucide-react";

import { ThemeModeButton } from "@/components/ThemeModeButton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CurrentUser } from "@/lib/types";
import { identifyPostHogUser, resetPostHogUser } from "@/lib/posthog";
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

// #1306: Google/GitHub login attaches a profile photo via the Cloud /me seam
// (see overlay/app/lib/me.ts). The engine CurrentUser type has no avatar field,
// so widen it locally here.
type CloudUser = CurrentUser & { picture?: string | null };

export function CloudAccountFooter({ onNavigate }: { onNavigate?: () => void } = {}) {
  const pathname = usePathname();
  const settingsActive = pathname === "/settings" || pathname.startsWith("/settings/");
  const isLoginPath =
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/app/login" ||
    pathname.startsWith("/app/login/");
  const [user, setUser] = useState<CloudUser | null>(null);
  // #1306: when the photo URL 404s/expires, fall back to initials.
  const [avatarFailed, setAvatarFailed] = useState(false);

  useEffect(() => {
    if (isLoginPath) return;
    let cancelled = false;
    fetch("/app/api/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && data?.user?.email) {
          const currentUser = data.user as CloudUser;
          setUser(currentUser);
          setAvatarFailed(false);
          identifyPostHogUser(currentUser);
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
  // #1306: show the real Google/GitHub photo when present and still loading;
  // fall back to a DiceBear `glass` mark on error or when no picture is
  // provided (mirrors the engine sidebar UserDiceBearAvatar — a calm geometric
  // mark, squircle, flat, no border), not bare initials.
  const avatarUrl = user?.picture && !avatarFailed ? user.picture : null;
  const dicebearUrl = `https://api.dicebear.com/9.x/glass/svg?seed=${encodeURIComponent(primary || "user")}&radius=0`;

  async function logout() {
    try {
      await fetch("/app/api/proxy/auth/logout", { method: "POST" });
    } catch {
      // Cookie clearing is best effort; navigate regardless.
    }
    resetPostHogUser();
    onNavigate?.();
    window.location.replace("/app/login?next=/app");
  }

  return (
    <div className="flex items-center gap-2 [border-top:var(--bd-div)] px-3 py-3">
      {/* Profile chip — clicking the avatar opens a dropdown with Settings +
          Sign out, so logout is reachable without a standalone footer button
          (parity with the engine UserProfileFooter, M37). */}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-button)] px-1 py-0.5 -mx-1 transition-[background,color] duration-150 ease-[var(--ease)]",
            "hover:bg-[var(--active-nav-bg)] focus:outline-none"
          )}
          aria-label="Profile menu"
        >
          {/* #1306: squared avatar (radius-button / 9px), NO border — matches
              the worker/employee card mark. Photo for Google/GitHub logins,
              DiceBear glass mark otherwise (and on photo load error), mirroring
              the engine sidebar UserDiceBearAvatar. */}
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt="Profile avatar"
              referrerPolicy="no-referrer"
              onError={() => setAvatarFailed(true)}
              className="size-7 shrink-0 rounded-[var(--radius-button)] object-cover"
            />
          ) : (
            <img
              src={dicebearUrl}
              alt="Profile avatar"
              className="size-7 shrink-0 rounded-[var(--radius-button)] border-0 object-cover"
            />
          )}
          <div className="min-w-0 leading-tight text-left">
            <p className="truncate text-xs font-medium text-foreground">{primary}</p>
            <p className="truncate text-[10px] text-muted-foreground">{secondary}</p>
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
