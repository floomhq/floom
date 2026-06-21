"use client";

// Nav badges (replacing the old global AlertsBell): the sidebar surfaces
// contextual counts on Approvals / Connections / Runs instead of one bell.
// All three derive from a single shared, polled fetch so the badges never
// each spin up their own request. Same pub/sub shape as useApprovalsSync.
//
// - Connections badge: connections needing re-auth (expired).
// - Runs badge: recent failing-worker clusters (failed runs).
// Both come from api.system.overview() — the same payload the old bell read.
// - Approvals badge: pending approvals still comes from useApprovalsCount()
//   (its own single source — see useApprovalsSync), not duplicated here.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SystemOverviewAttentionItem } from "@/lib/types";

export interface SelfOverviewCounts {
  /** Connections needing re-auth (expired). */
  connectionsExpired: number;
  /** Recent failing runs (sum of failure clusters in the last 24h). */
  failedRuns: number;
}

const POLL_MS = 30_000;

function isExpiredConnection(item: SystemOverviewAttentionItem): boolean {
  return (item.kind ?? item.type) === "connection_expired";
}

function isFailing(item: SystemOverviewAttentionItem): boolean {
  return item.kind === "failing" || item.type === "failure_cluster";
}

function deriveCounts(items: SystemOverviewAttentionItem[]): SelfOverviewCounts {
  const connectionsExpired = items.filter(isExpiredConnection).length;
  const failedRuns = items
    .filter(isFailing)
    .reduce((total, item) => total + (item.recent_failure_count ?? 1), 0);
  return { connectionsExpired, failedRuns };
}

/**
 * Live nav-badge counts derived from a single shared overview fetch.
 * Revalidates on mount, on a 30s poll, and on window focus/visibility.
 */
export function useNavBadgeCounts(): SelfOverviewCounts {
  const [counts, setCounts] = useState<SelfOverviewCounts>({
    connectionsExpired: 0,
    failedRuns: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const refetch = async () => {
      try {
        const result = await api.system.overview();
        if (!cancelled) setCounts(deriveCounts(result.needs_attention ?? []));
      } catch {
        // silently ignore — badges just keep their last known value
      }
    };

    refetch();
    const interval = setInterval(refetch, POLL_MS);
    const onFocus = () => refetch();
    const onVisible = () => {
      if (document.visibilityState === "visible") refetch();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return counts;
}

// Exported for unit tests — derive counts without the React lifecycle.
export const __deriveCounts = deriveCounts;
