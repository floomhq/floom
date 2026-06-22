"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogOut, Settings } from "lucide-react";

import { Avatar } from "@/components/ui/Avatar";
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
  if (typeof window === "undefined" || !window.localStorage) return next;
  const workspaceId = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  if (workspaceId && workspaceId !== "local-default") {
    next.set("x-workeros-workspace", workspaceId);
  }
  return next;
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

  useEffect(() => {
    if (isLoginPath) return;
    let cancelled = false;
    fetch("/app/api/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && data?.user?.email) {
          const currentUser = data.user as CloudUser;
          setUser(currentUser);
          identifyPostHogUser(currentUser);
          fetch("/app/api/proxy/auth/tokens/bootstrap", {
            method: "POST",
            headers: activeWorkspaceHeaders(),
            // #1446: do not swallow silently; a failed token bootstrap leaves
            // the session unable to reach the API. Log for ops.
          }).catch((err) => console.error("Token bootstrap failed", err));
        } else if (!cancelled) {
          window.location.replace("/app/login?next=/app");
        }
      })
      .catch((err) => {
        // #1446: log the load failure before redirecting to login so ops can
        // tell a real /me outage apart from an expected logged-out state.
        console.error("Could not load current user", err);
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
          {/* #1306 / M36: profile photo (Google/GitHub) beats generated mark.
              Avatar handles the override ladder: src present → real photo
              cropped to the circle (user = human); absent → generated mark. */}
          <Avatar role="user" name={primary} src={user?.picture ?? null} size={28} />
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
