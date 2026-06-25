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
import { clearClientLogoutState } from "@/lib/auth/logout-cleanup";
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

// Module-level cache for the signed-in cloud user.
// Mirrors _cachedWorkspaceName in sidebar.engine: on remount (sidebar
// collapse/expand or SPA navigation) the cache seeds useState immediately so
// the Avatar never renders with a null/placeholder seed — no flash between
// the "Local user" generated mark and the real user mark.
// Populated on first successful /api/me fetch; cleared to null on logout.
let _cachedCloudUser: CloudUser | null = null;

// #749: the module-level cache above is wiped on a hard reload, so the footer
// re-renders a placeholder while /api/me round-trips the (slow) backend, then
// flashes to the real identity. Mirror the cache into sessionStorage so a reload
// seeds the real user INSTANTLY. The /api/me fetch + token-bootstrap below still
// runs to validate/refresh — this only changes the first-paint seed.
const _CLOUD_USER_SESSION_KEY = "floom_cloud_user";
export function readSessionCloudUser(): CloudUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(_CLOUD_USER_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CloudUser;
    return parsed && parsed.email ? parsed : null;
  } catch {
    return null;
  }
}
export function writeSessionCloudUser(u: CloudUser): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(_CLOUD_USER_SESSION_KEY, JSON.stringify(u));
  } catch {
    /* private mode / quota — non-fatal, falls back to the live fetch */
  }
}
export function clearSessionCloudUser(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(_CLOUD_USER_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function CloudAccountFooter({ onNavigate }: { onNavigate?: () => void } = {}) {
  const pathname = usePathname();
  const settingsActive = pathname === "/settings" || pathname.startsWith("/settings/");
  const isLoginPath =
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/app/login" ||
    pathname.startsWith("/app/login/");
  // Seed from module-level cache, then sessionStorage (#749): remounts (sidebar
  // collapse/expand) hit the module cache; a hard reload falls through to
  // sessionStorage so the mark renders immediately without waiting for the (slow)
  // /api/me round-trip — no placeholder flash.
  const [user, setUser] = useState<CloudUser | null>(
    () => _cachedCloudUser ?? readSessionCloudUser(),
  );

  useEffect(() => {
    if (isLoginPath) return;
    // Already cached: skip the fetch — the mark is stable from the prior load.
    if (_cachedCloudUser) return;
    let cancelled = false;
    fetch("/app/api/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && data?.user?.email) {
          const currentUser = data.user as CloudUser;
          _cachedCloudUser = currentUser;
          writeSessionCloudUser(currentUser);
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
    _cachedCloudUser = null;
    clearSessionCloudUser();
    clearClientLogoutState();
    // Backend clears workeros_active_workspace on logout; mirror it client-side
    // so a re-login does not inherit the prior user's workspace selection.
    if (typeof document !== "undefined") {
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `workeros_active_workspace=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    }
    resetPostHogUser();
    onNavigate?.();
    window.location.replace("/app/login?next=/app&switch=1");
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
          {/* Pass user_id as stable seed so the mark is fixed for this user
              and does NOT change when display_name resolves (null → "Federico
              De Ponte" would otherwise produce two different marks = flash). */}
          <Avatar role="user" id={user?.user_id} name={primary} src={user?.picture ?? null} size={28} />
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
