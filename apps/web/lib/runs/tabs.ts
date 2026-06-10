// Run detail tab set, locked to APP-UI-V4-SPEC §4: Output · Trace · Inputs · Raw.
// (Was Output/Steps/Tools/Cost.) Constant + test guard the contract.
export const RUN_DETAIL_TABS = ["Output", "Trace", "Inputs", "Raw"] as const;
export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];
