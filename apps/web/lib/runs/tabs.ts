// Run detail tab set: Output · Trace · Inputs. Raw JSON is reachable from Trace.
export const RUN_DETAIL_TABS = ["Output", "Trace", "Inputs"] as const;
export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];
