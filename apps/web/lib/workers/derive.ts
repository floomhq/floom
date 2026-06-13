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

/** Worker status → outlined pill (mirrors the old footerStatus).
 *  v4 vocab: lowercase, employee-model labels (ok/running/failed/needs attention). */
export function workerStatusPill(w: WorkerSummary): { tone: PillTone; label: string } {
  // Check if the worker is currently running
  if (w.last_run?.status === "running") return { tone: "run", label: "running" };
  switch (w.status) {
    case "error":
      return { tone: "err", label: "failed" };
    case "needs_attention":
      return { tone: "warn", label: "needs attention" };
    case "missing_secret":
      return { tone: "warn", label: "missing secret" };
    case "healthy":
      return { tone: "ok", label: "ok" };
    default:
      return { tone: "ok", label: "ok" };
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

/** ISO timestamp of most recent worker activity, using run time then edit/create fallbacks. */
export function workerActivityTimestamp(w: WorkerSummary): number {
  const iso =
    w.recent_stats?.last_run_at ||
    w.last_run?.started_at ||
    w.last_run?.created_at ||
    w.updated_at ||
    w.created_at ||
    "";
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

export function isRecent(w: WorkerSummary, now: number): boolean {
  const t = workerActivityTimestamp(w);
  return t > 0 && now - t <= RECENT_WINDOW_MS;
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

/** Canonical worker source-file order for the Source sub-tabs (SPEC §11). */
export const SOURCE_FILE_ORDER = ["worker.yml", "SKILL.md", "run.py", "requirements.txt"];

/** Files with content, canonical order first, then any other text files. */
export function orderedSourceFiles<T extends { path: string; content?: string | null }>(
  files: T[],
): T[] {
  const withContent = files.filter((f) => f.content != null);
  const canon = SOURCE_FILE_ORDER.map((p) => withContent.find((f) => f.path === p)).filter(
    (f): f is T => Boolean(f),
  );
  const extras = withContent.filter((f) => !SOURCE_FILE_ORDER.includes(f.path));
  return [...canon, ...extras];
}

/** Unique content-tag options across the visible workers (sorted, with counts). */
export function contentTagOptions(workers: WorkerSummary[]): TagOption[] {
  const counts = new Map<string, number>();
  for (const w of workers) for (const t of w.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: value, count }));
}
