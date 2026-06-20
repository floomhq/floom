"use client";

import { useEffect } from "react";

import { api, getActiveWorkspaceId } from "@/lib/api";
import {
  capturePostHogEvent,
  groupPostHogWorkspace,
  identifyPostHogUser,
} from "@/lib/posthog";

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
  useEffect(() => {
    let active = true;

    // Attach the locally-known workspace immediately so even pre-/me events
    // (and the local-default single-tenant case) are workspace-attributed.
    const localWorkspace = getActiveWorkspaceId();
    if (localWorkspace) {
      groupPostHogWorkspace(localWorkspace);
    }

    api
      .me()
      .then((user) => {
        if (!active || !user?.user_id) return;
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
  }, []);

  return null;
}
