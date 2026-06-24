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

// User-facing tab labels. The internal tab KEY stays "Brain" (it is the stable
// id used by the tab→component map, the localStorage pin key, and the §4
// contract test), but the operator-facing name of this feature was standardized
// to "Library" to match the left-nav item — the engine internally calls it the
// "brain"/contexts, the UI says "Library". Only the visible label changes here;
// ids/routes are untouched.
export const WORKER_DETAIL_TAB_LABEL: Record<WorkerDetailTab, string> = {
  Overview: "Overview",
  Runs: "Runs",
  Setup: "Setup",
  Source: "Source",
  Versions: "Versions",
  Brain: "Library",
  Tools: "Tools",
};

// Setup second-row sub-tabs (no sidebar; round-09 worker-detail-v2).
export const SETUP_SUBTABS = [
  "Inputs",
  "Alerts & webhooks",
  "Triggers",
  "Limits",
] as const;

export type SetupSubtab = (typeof SETUP_SUBTABS)[number];

/** localStorage key — persists the Advanced disclosure open/closed state. */
export const ADVANCED_MODE_STORAGE_KEY = "workeros:worker-advanced-open";
