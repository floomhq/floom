// The worker detail tab set (round-09 approved structure, worker-detail-v2.md):
//   PRIMARY:  Overview · Runs · Operations
//   ADVANCED: Source · Versions · Brain · Tools   (quiet, secondary group)
// Operations is itself a second-row tab host (Inputs / Alerts & webhooks /
// Triggers / Limits) — see OperationsTab. Config was folded into Operations and
// Triggers moved under Operations. Kept as a typed constant so a test can guard
// the contract and the component can't silently drift back to the old set.
export const WORKER_DETAIL_TABS = [
  "Overview",
  "Runs",
  "Operations",
  "Source",
  "Versions",
  "Brain",
  "Tools",
] as const;

export type WorkerDetailTab = (typeof WORKER_DETAIL_TABS)[number];

// Operations second-row sub-tabs (no sidebar; round-09 worker-detail-v2).
export const OPERATIONS_SUBTABS = [
  "Inputs",
  "Alerts & webhooks",
  "Triggers",
  "Limits",
] as const;

export type OperationsSubtab = (typeof OPERATIONS_SUBTABS)[number];
