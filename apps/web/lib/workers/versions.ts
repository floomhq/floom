// Worker Versions tab (APP-UI-V4-SPEC §4): git log in the GLOBAL list style —
// "message + `sha · author · age`, current marker". Pure formatting so the row
// rendering is unit-testable; the component just maps these onto <Collection>'s
// list classes.
import type { VersionSummary } from "@/lib/types";

/** Short relative age, e.g. "just now", "5m", "3h", "2d", "4w". */
export function relativeAge(iso: string | undefined, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.round(d / 7)}w`;
}

export interface VersionRow {
  id: string;
  message: string;
  /** `sha · author · age` meta line. */
  meta: string;
  isCurrent: boolean;
}

export function formatVersionRow(
  v: VersionSummary,
  now: number,
  currentSha?: string | null
): VersionRow {
  const sha = (v.sha || v.id || "").slice(0, 7);
  const parts = [sha, v.author?.trim(), relativeAge(v.timestamp, now)].filter(Boolean);
  return {
    id: v.id,
    message: v.message?.trim() || "(no message)",
    meta: parts.join(" · "),
    isCurrent: !!currentSha && (v.sha === currentSha || v.id === currentSha),
  };
}

/** The newest version is "current" when no explicit current sha is known. */
export function formatVersionRows(
  versions: VersionSummary[],
  now: number,
  currentSha?: string | null
): VersionRow[] {
  const effectiveCurrent = currentSha ?? versions[0]?.sha ?? null;
  return versions.map((v) => formatVersionRow(v, now, effectiveCurrent));
}
