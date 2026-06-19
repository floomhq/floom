/**
 * Per-user pinned advanced tabs for the worker detail pane.
 *
 * The default tab bar is always Overview · Runs. The three power-user tabs
 * (Config · Source · Versions) are pinnable: a user who wants to "always see
 * Source" pins it once and it appears in the tab bar for EVERY worker, on this
 * device. This is a per-user global preference, not per-worker — stored in
 * localStorage so it survives reloads without any server-side persistence.
 *
 * Shape (localStorage `floom.workerDetail.pinnedTabs`): a JSON string[] holding
 * the pinned advanced tab keys, e.g. ["Source"] or ["Config","Versions"].
 * Order in the stored array is ignored; the tab bar always renders advanced
 * tabs in their canonical ADVANCED_DETAIL_TABS order.
 */
import { safeStorageGet, safeStorageSet } from "@/lib/safe-storage";
import { WORKER_DETAIL_TABS, type WorkerDetailTab } from "@/lib/workers/tabs";

const LS_KEY_PINNED_TABS = "floom.workerDetail.pinnedTabs";

/** Always-visible PRIMARY tabs (never pinnable, never hidden). round-09:
 *  Overview · Runs · Setup. The advanced group (Source/Versions/Brain/
 *  Tools) is quiet/secondary and pinnable via the Customize control. */
export const BASE_DETAIL_TABS = ["Overview", "Runs", "Setup"] as const;

/** The advanced tabs that can be pinned, in canonical render order. */
export const ADVANCED_DETAIL_TABS = WORKER_DETAIL_TABS.filter(
  (t): t is WorkerDetailTab => !BASE_DETAIL_TABS.includes(t as (typeof BASE_DETAIL_TABS)[number]),
);

const ADVANCED_SET = new Set<WorkerDetailTab>(ADVANCED_DETAIL_TABS);

function isAdvancedTab(value: string): value is WorkerDetailTab {
  return ADVANCED_SET.has(value as WorkerDetailTab);
}

export function getPinnedTabs(): Set<WorkerDetailTab> {
  try {
    const raw = safeStorageGet("local", LS_KEY_PINNED_TABS);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return new Set();
    // Filter to known advanced tabs so a stale/renamed key never poisons the bar.
    return new Set(parsed.filter((v): v is WorkerDetailTab => typeof v === "string" && isAdvancedTab(v)));
  } catch {
    return new Set();
  }
}

export function savePinnedTabs(pinned: Set<WorkerDetailTab>): void {
  // Persist in canonical order for a deterministic stored value.
  const ordered = ADVANCED_DETAIL_TABS.filter((t) => pinned.has(t));
  safeStorageSet("local", LS_KEY_PINNED_TABS, JSON.stringify(ordered));
}
