"use client";

// #943 — shared role check for owner/admin-only surfaces (secret inventory).
// Single-tenant deployments have no roles (role == null) and the sole user is
// the owner. is_admin from the API wins when present; otherwise the role
// string decides. Mirrors the long-standing logic on the Settings page.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CurrentUser } from "@/lib/types";

export function computeIsAdmin(u: CurrentUser | null | undefined): boolean {
  if (!u) return false;
  return (
    u.is_admin ?? (u.role == null ? true : u.role === "admin" || u.role === "owner")
  );
}

/**
 * Resolves the caller's admin/owner status. `pending` is true until /me
 * answers; gate sensitive content on `pending === false && isAdmin`.
 * Fails closed: a /me error reports non-admin.
 */
export function useIsAdmin(): { isAdmin: boolean; pending: boolean } {
  const [state, setState] = useState<{ isAdmin: boolean; pending: boolean }>({
    isAdmin: false,
    pending: true,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const u = await api.me();
        if (!cancelled) setState({ isAdmin: computeIsAdmin(u), pending: false });
      } catch {
        if (!cancelled) setState({ isAdmin: false, pending: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
