/**
 * Pure worker → Collection derivations (SPEC §5 Workers, §11/§12).
 * Status pill mapping, smart/status/visibility/content tag extraction, and the
 * "system worker" filter — all pure so they can be unit-tested.
 */
import type { WorkerSummary } from "@/lib/types";
import type { PillTone, TagFamilyKey, TagOption } from "@/lib/collection/types";

export const SYSTEM_WORKER_ID_FALLBACK = new Set(["worker-author"]);

export function isSystemWorker(w: Pick<WorkerSummary, "system" | "id">): boolean {
  return w.system === true || SYSTEM_WORKER_ID_FALLBACK.has(w.id);
}

/** Worker status → outlined pill (mirrors the old footerStatus). */
export function workerStatusPill(w: WorkerSummary): { tone: PillTone; label: string } {
  switch (w.status) {
    case "error":
      return { tone: "err", label: "Error" };
    case "needs_attention":
      return { tone: "warn", label: "Needs attention" };
    case "missing_secret":
      return { tone: "warn", label: "Missing secret" };
    case "healthy":
      return { tone: "ok", label: "Healthy" };
    default:
      return { tone: "ok", label: "Ready" };
  }
}

/** The status-tag key for filtering (SPEC: Running/Failing/Needs-attention). */
export function workerStatusKey(w: WorkerSummary): string {
  if (w.last_run?.status === "running") return "running";
  if (w.status === "error") return "failing";
  if (w.status === "needs_attention" || w.status === "missing_secret") return "needs-attention";
  return "healthy";
}

const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days (SPEC §1 "Recent")

export function isRecent(w: WorkerSummary, now: number): boolean {
  const ts = w.recent_stats?.last_run_at;
  if (!ts) return false;
  const t = Date.parse(ts);
  return Number.isFinite(t) && now - t <= RECENT_WINDOW_MS;
}

/** The smart-tag values a worker carries (starred is external/localStorage). */
export function workerSmartTags(w: WorkerSummary, opts: { starred: boolean; now: number }): string[] {
  const out: string[] = [];
  if (opts.starred) out.push("starred");
  if (isRecent(w, opts.now)) out.push("recent");
  if (w.archived) out.push("archived");
  return out;
}

export function workerTags(
  w: WorkerSummary,
  opts: { starred: boolean; now: number },
): Partial<Record<TagFamilyKey, string[]>> {
  return {
    smart: workerSmartTags(w, opts),
    status: [workerStatusKey(w)],
    visibility: [w.visibility === "workspace" ? "shared" : "private"],
    content: w.tags ?? [],
  };
}

/** Unique content-tag options across the visible workers (sorted, with counts). */
export function contentTagOptions(workers: WorkerSummary[]): TagOption[] {
  const counts = new Map<string, number>();
  for (const w of workers) for (const t of w.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: value, count }));
}
