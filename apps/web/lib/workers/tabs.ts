// The worker detail tab set (round-09 approved structure, worker-detail-v2.md):
//   PRIMARY:  Overview · Runs · Setup
//   ADVANCED: Source · Versions · Brain · Tools   (quiet, secondary group)
// Setup is itself a second-row tab host (Inputs / Alerts & webhooks /
// Triggers / Limits) — see SetupTab. Config was folded into Setup and
// Triggers moved under Setup. Kept as a typed constant so a test can guard
// the contract and the component can't silently drift back to the old set.
export const WORKER_DETAIL_TABS = [
  "Overview",
  "Runs",
  "Setup",
  "Source",
  "Versions",
  "Brain",
  "Tools",
] as const;

export type WorkerDetailTab = (typeof WORKER_DETAIL_TABS)[number];

// Setup second-row sub-tabs (no sidebar; round-09 worker-detail-v2).
export const SETUP_SUBTABS = [
  "Inputs",
  "Alerts & webhooks",
  "Triggers",
  "Limits",
] as const;

export type SetupSubtab = (typeof SETUP_SUBTABS)[number];
