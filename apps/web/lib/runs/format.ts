/**
 * Pure run formatting + Collection derivations (SPEC §5 Runs).
 * Day-group labels, duration, trigger normalization, status pill/key mapping.
 */
import type { RunSummary, RunStatus } from "@/lib/types";
import type { PillTone } from "@/lib/collection/types";

export function formatDuration(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

/** Trigger family key (Scheduled / Manual / Webhook — SPEC §11). */
export function triggerKey(source?: string): string {
  const s = (source ?? "manual").toLowerCase();
  if (s === "manual" || s === "") return "manual";
  if (s === "webhook") return "webhook";
  if (s === "scheduled" || s === "cron" || s === "schedule") return "scheduled";
  return s;
}

export function formatTrigger(source?: string): string {
  const k = triggerKey(source);
  if (k === "manual") return "Manual";
  if (k === "webhook") return "Webhook";
  if (k === "scheduled") return "Scheduled";
  return k.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function runStatusPill(status: RunStatus): { tone: PillTone; label: string } {
  switch (status) {
    case "completed":
      return { tone: "ok", label: "Completed" };
    case "failed":
      return { tone: "err", label: "Failed" };
    case "cancelled":
      return { tone: "err", label: "Cancelled" };
    case "running":
      return { tone: "run", label: "Running" };
    case "pending_approval":
      return { tone: "warn", label: "Awaiting approval" };
    default:
      return { tone: "idle", label: "Queued" };
  }
}

/** Day-group label for the run list (Today / Yesterday / weekday date). */
export function dayLabel(iso: string | undefined, now: number): string {
  if (!iso) return "Unknown date";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "Unknown date";
  const d = new Date(t);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayMs = 86400000;
  const diff = Math.round((startOf(today) - startOf(d)) / dayMs);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function runSortTime(r: RunSummary): number {
  return Date.parse(r.created_at ?? r.started_at ?? "") || 0;
}

/** Flatten runs into CSV rows (pure; the unparse/download stays in the view). */
export function runsToCsvRows(
  runs: RunSummary[],
): Record<string, string | number>[] {
  return runs.map((r) => ({
    id: r.id,
    worker_id: r.worker_id,
    worker_name: r.worker_name ?? "",
    status: r.status,
    trigger_source: r.trigger_source,
    created_at: r.created_at || "",
    started_at: r.started_at || "",
    completed_at: r.completed_at || "",
    duration_ms: r.duration_ms ?? "",
  }));
}
