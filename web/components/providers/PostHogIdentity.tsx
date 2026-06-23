"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { api, getActiveWorkspaceId } from "@/lib/api";
import {
  capturePostHogEvent,
  groupPostHogWorkspace,
  identifyPostHogUser,
} from "@/lib/posthog";

// Public / unauthenticated routes where /me would 401. Calling api.me() there
// triggers redirectToLoginOnce (a redundant /login reload), so we skip the
// identity fetch on these routes entirely.
const PUBLIC_ROUTE_PREFIXES = [
  "/login",
  "/auth",
  "/cli-auth",
  "/review",
  "/s/",
  "/start",
  "/privacy",
  "/terms",
];

function isPublicRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return PUBLIC_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix)
  );
}

// Wires PostHog person identity + the `workspace` group from the authenticated
// session, and emits `login_completed` once per established session.
//
// On mount it fetches /me (authoritative current user). When a user is present
// it identifies the person and attaches the active workspace as the PostHog
// `workspace` group, so EVERY subsequent client event carries
// $groups.workspace and joins the server-side per-workspace funnels (server
// uses the same group key "workspace").
//
// Workspace SWITCH does a full window.location.reload() (see WorkspaceSwitcher),
// so this provider re-mounts and re-attaches the new workspace group on switch
// — no separate switch listener needed.
//
// `login_completed` is emitted here, not in the login form, because session
// establishment is what matters and the OSS login form replaces the route on
// success; firing on first authenticated /me is the reliable signal. A
// sessionStorage guard keeps it to once per browser session (one login).
const LOGIN_FIRED_KEY = "workeros.posthog.loginFired";

export function PostHogIdentity() {
  const pathname = usePathname();
  // Fetch /me only until identity is established once, then stop (subsequent
  // navigations re-run this effect but should not re-hit /me).
  const identifiedRef = useRef(false);

  useEffect(() => {
    let active = true;

    // Attach the locally-known workspace immediately so even pre-/me events
    // (and the local-default single-tenant case) are workspace-attributed.
    const localWorkspace = getActiveWorkspaceId();
    if (localWorkspace) {
      groupPostHogWorkspace(localWorkspace);
    }

    // On public/auth routes /me would 401 and bounce to /login; skip it. Once
    // identity is established, skip the redundant per-navigation /me fetch.
    if (identifiedRef.current || isPublicRoute(pathname)) {
      return () => {
        active = false;
      };
    }

    api
      .me()
      .then((user) => {
        if (!active || !user?.user_id) return;
        identifiedRef.current = true;
        identifyPostHogUser(user);
        const workspaceId = user.workspace_id || localWorkspace;
        if (workspaceId) {
          groupPostHogWorkspace(workspaceId);
        }

        // Emit login_completed once per browser session.
        try {
          if (typeof window !== "undefined" && !sessionStorage.getItem(LOGIN_FIRED_KEY)) {
            sessionStorage.setItem(LOGIN_FIRED_KEY, "1");
            capturePostHogEvent("login_completed", {
              workspace_id: workspaceId || undefined,
            });
          }
        } catch {
          // sessionStorage can be unavailable (private mode); skip the guard.
        }
      })
      .catch(() => {
        // Anonymous / unauthenticated (e.g. on /login): no identity to attach.
      });

    return () => {
      active = false;
    };
  }, [pathname]);

  return null;
}
