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
