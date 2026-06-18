// Run detail tab set: Output · Logs · Inputs. The "Raw" view is a Preview/Raw
// toggle on the Output result (and on each file), not a separate tab.
export const RUN_DETAIL_TABS = ["Output", "Logs", "Inputs"] as const;
export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];
