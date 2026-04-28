/**
 * SettingsRail — v26 settings pages use the RunRail shell.
 * /settings/* pages are tabbed sub-views of the workspace settings; they
 * share the same left rail as the Run workspace context.
 */
import { RunRail } from './RunRail';

export function SettingsRail() {
  return <RunRail />;
}
