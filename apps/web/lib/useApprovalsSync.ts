"use client";

// G5 P2 (rescore2 2026-05-29): the Approvals nav badge and the /approvals list
// read from independent fetches with different lifetimes, so the badge could
// show "1" while the list said "none" (and stayed "1" after an approval until a
// manual reload). This module is the single source the badge + list both use:
//
// - useApprovalsCount(): badge subscribes; refetches on mount, on a slow poll,
//   on window focus, and whenever notifyApprovalsChanged() fires.
// - notifyApprovalsChanged(): called by the list after any approve/reject so the
//   badge (and any other subscriber) revalidates immediately — no reload.
//
// Plain module-level pub/sub (no extra dependency) keeps it ChatGPT-simple.

import { useCallback, useEffect } from "react";
import { useApprovalsCountQuery } from "@/lib/query/hooks";

const listeners = new Set<() => void>();

/** Tell every subscriber to revalidate the pending-approvals count/list now. */
export function notifyApprovalsChanged(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const POLL_MS = 30_000;

/**
 * Live pending-approvals count for the nav badge. Revalidates on mount, on a
 * 30s poll, on window focus/visibility, and on notifyApprovalsChanged().
 */
export function useApprovalsCount(): number {
  const { data, refetch } = useApprovalsCountQuery();

  useEffect(() => {
    const refetchCount = () => {
      void refetch();
    };

    refetchCount();
    const interval = setInterval(refetchCount, POLL_MS);
    const onFocus = () => refetchCount();
    const onVisible = () => {
      if (document.visibilityState === "visible") refetchCount();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const unsubscribe = subscribe(refetchCount);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, [refetch]);

  return data?.pending ?? 0;
}

/**
 * Subscribe a list reload to the same triggers as the badge (focus + the shared
 * change signal). Returns nothing; the caller passes its own `load` callback.
 */
export function useApprovalsListSync(load: () => void): void {
  const stableLoad = useCallback(() => load(), [load]);
  useEffect(() => {
    const onFocus = () => stableLoad();
    const onVisible = () => {
      if (document.visibilityState === "visible") stableLoad();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const unsubscribe = subscribe(stableLoad);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, [stableLoad]);
}
