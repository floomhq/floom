// The worker detail tab set, locked to APP-UI-V4-SPEC §4:
//   Overview · History · Source · Versions · Config
// (v4 reconsolidated the prior 7 tabs — About/Run/Runs/Source/Settings/Brain/Tools.)
// Kept as a typed constant so a test can guard the contract and the component
// can't silently drift back to the old set.
export const WORKER_DETAIL_TABS = [
  "Overview",
  "History",
  "Source",
  "Versions",
  "Config",
] as const;

export type WorkerDetailTab = (typeof WORKER_DETAIL_TABS)[number];

/**
 * Tabs visible in default operator view (non-technical).
 * Brain/Tools/Triggers live inside Config — Config stays operator-visible.
 */
export const OPERATOR_TABS: readonly WorkerDetailTab[] = ["Overview", "History", "Config"] as const;

/**
 * Tabs hidden behind the "Advanced" toggle (developer/technical tabs).
 */
export const ADVANCED_TABS: readonly WorkerDetailTab[] = ["Source", "Versions"] as const;

/** localStorage key for Advanced panel persistence. */
export const ADVANCED_MODE_STORAGE_KEY = "workeros:worker-advanced-open";
