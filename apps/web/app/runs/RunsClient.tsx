"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RunStatusBadge, RunStatusGlyph } from "@/components/RunStatus";
import { WorkerAvatar } from "@/components/WorkerAvatar";
import { formatRelative, formatTimeOfDay } from "@/lib/formatters";
import { humanizeRunError } from "@/lib/run-format";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Download, Play } from "lucide-react";
import type { RunSummary, WorkerSummary } from "@/lib/types";

// Filter out system/test workers from the operator-facing filter dropdown.
// Matches: audit-*, node-smoke-*, mcp-*-smoke, *-smoke-*, *quality-gate*
const SYSTEM_WORKER_PATTERNS = [
  /^audit-/i,
  /^node-smoke/i,
  /smoke/i,
  /quality.gate/i,
  /-smoke$/i,
];

function isSystemOrTestWorker(w: WorkerSummary): boolean {
  const id = w.id.toLowerCase();
  const name = (w.name || "").toLowerCase();
  return SYSTEM_WORKER_PATTERNS.some((p) => p.test(id) || p.test(name));
}

const STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const PAGE_SIZE = 20;
const SUCCESS_STATES = new Set(["completed", "success", "succeeded"]);

export default function RunsClient({
  initialRuns,
  initialWorkers,
}: {
  initialRuns: RunSummary[];
  initialWorkers: WorkerSummary[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const workerFilter = searchParams.get("worker_id") ?? searchParams.get("worker") ?? "";
  const statusFilter = searchParams.get("status") ?? "";

  // S44: initialRuns from RSC — no loading flash on first render.
  const [runs, setRuns] = useState<RunSummary[]>(initialRuns);
  const [workers, setWorkers] = useState<WorkerSummary[]>(initialWorkers);
  // Only show loading when filters change (not on initial render)
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(initialRuns.length === PAGE_SIZE);
  // Track whether we've applied filters (RSC data had no filters)
  const [filtersApplied, setFiltersApplied] = useState(false);

  const updateFilter = useCallback((key: "status" | "worker_id", value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.replace(`/runs${params.size ? `?${params.toString()}` : ""}`, { scroll: false });
  }, [router, searchParams]);

  // If workers list wasn't pre-fetched (API error), fetch client-side
  useEffect(() => {
    if (initialWorkers.length === 0) {
      api.workers.list().then(setWorkers).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch when filters change (or if initial data was empty)
  useEffect(() => {
    const hasFilters = Boolean(workerFilter || statusFilter);
    const needsFetch = hasFilters || initialRuns.length === 0;
    if (!needsFetch && !filtersApplied) return;

    setFiltersApplied(true);
    setOffset(0);
    setRuns([]);
    fetchRuns(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerFilter, statusFilter]);

  async function fetchRuns(currentOffset: number, replace = false) {
    if (currentOffset === 0) setLoading(true);
    else setLoadingMore(true);
    try {
      const params: { worker_id?: string; status?: string; limit: number; offset: number } = {
        limit: PAGE_SIZE,
        offset: currentOffset,
      };
      if (workerFilter) params.worker_id = workerFilter;
      if (statusFilter) params.status = statusFilter;
      const result = await api.runs.list(params);
      if (replace) setRuns(result);
      else setRuns((prev) => [...prev, ...result]);
      setHasMore(result.length === PAGE_SIZE);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  function goToPage(page: number) {
    const next = (page - 1) * PAGE_SIZE;
    setOffset(next);
    fetchRuns(next, true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const groupedRuns = groupRunsByDay(runs);

  const API_PAGE_MAX = 500;

  async function exportCSV() {
    const baseParams: { worker_id?: string; status?: string; limit: number; offset: number } = {
      limit: API_PAGE_MAX,
      offset: 0,
    };
    if (workerFilter) baseParams.worker_id = workerFilter;
    if (statusFilter) baseParams.status = statusFilter;

    let allRuns: typeof runs = [];
    let offset = 0;
    try {
      while (true) {
        const page = await api.runs.list({ ...baseParams, offset });
        allRuns = [...allRuns, ...page];
        if (page.length < API_PAGE_MAX) break;
        offset += API_PAGE_MAX;
      }
    } catch {
      allRuns = runs;
    }
    const rows = allRuns.map((r) => ({
      id: r.id,
      worker_id: r.worker_id,
      status: r.status,
      trigger_source: r.trigger_source,
      created_at: r.created_at || "",
      started_at: r.started_at || "",
      completed_at: r.completed_at || "",
      duration_ms: r.duration_ms ?? "",
    }));
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `workeros-runs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    // FL18: grow to fill the full content height so the page doesn't leave
    // bottom whitespace on tall viewports.
    <div className="flex flex-1 flex-col space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Run history</h1>
          <p className="text-muted-foreground text-sm mt-1">Worker executions grouped by day.</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={exportCSV}
          disabled={runs.length === 0}
          className="gap-1.5 text-muted-foreground"
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </Button>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <Select value={workerFilter} onValueChange={(v) => updateFilter("worker_id", v ?? "")}>
          <SelectTrigger className="w-[220px] text-sm h-8">
            <SelectValue placeholder="All workers" />
          </SelectTrigger>
          <SelectContent className="w-[320px]">
            <SelectItem value="">All workers</SelectItem>
            {workers
              .filter((w) => !isSystemOrTestWorker(w))
              .map((w) => (
                <SelectItem key={w.id} value={w.id} title={w.name}>
                  <span className="block truncate max-w-[280px]">{w.name}</span>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-3 flex-wrap">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => updateFilter("status", opt.value)}
              className={`relative pb-1.5 text-sm transition-colors ${
                statusFilter === opt.value
                  ? "text-foreground font-medium after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-none border-b border-[var(--border-default)] last:border-b-0" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] py-12 flex flex-col items-center gap-3 text-center">
          <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
            <Play className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {workerFilter || statusFilter ? "No runs match these filters" : "No runs yet"}
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              {workerFilter || statusFilter
                ? "Try clearing filters to see all runs."
                : "Runs appear here when you execute a worker manually or via a trigger."}
            </p>
          </div>
          {!workerFilter && !statusFilter && (
            <Link href="/workers">
              <Button size="sm" variant="outline" className="mt-1">
                <Play className="w-3.5 h-3.5 mr-1.5" />
                Run a worker
              </Button>
            </Link>
          )}
          {(workerFilter || statusFilter) && (
            <button
              type="button"
              onClick={() => { updateFilter("status", ""); updateFilter("worker_id", ""); router.replace("/runs", { scroll: false }); }}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Single unified container — one border, one set of rounded corners, no per-group cards */}
          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
            {/* Column headers — shown once at the top of the whole list */}
            <div className="hidden md:grid grid-cols-[minmax(0,1fr)_120px_110px_150px_160px] gap-4 px-4 py-2 border-b border-[var(--border-default)] text-[11px] font-medium text-muted-foreground">
              <span>Worker</span>
              <span>Trigger</span>
              <span>Duration</span>
              <span>Status</span>
              <span>Started</span>
            </div>
            {groupedRuns.map((group, groupIdx) => (
              <section key={group.key}>
                {/* Group header: inset row, no rounded corners, straight full-width divider */}
                <div className={`flex items-center justify-between gap-3 px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-2)]${groupIdx > 0 ? " border-t" : ""}`}>
                  <h2 className="text-xs font-semibold uppercase text-muted-foreground">
                    {group.label}
                  </h2>
                  <span className="text-[11px] text-muted-foreground">
                    {formatRunCountSummary(group.runs)}
                  </span>
                </div>
                {group.runs.map((r) => (
                  <Link
                    key={r.id}
                    href={`/runs/${r.id}`}
                    title={r.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_120px_110px_150px_160px] gap-4 px-4 py-3 border-b border-[var(--border-default)] last:border-b-0 hover:bg-[var(--active-nav-bg)] transition-colors items-center cursor-pointer"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2.5 min-w-0">
                        <WorkerAvatar seed={r.worker_id} name={r.worker_name || r.worker_id} size="size-6" />
                        <Link
                          href={`/workers/${r.worker_id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-sm font-medium truncate hover:underline"
                        >
                          {r.worker_name || r.worker_id}
                        </Link>
                      </span>
                      {r.error && (
                        <span className="mt-1 block truncate text-[11px] text-error/80">
                          {summarizeError(r.error)}
                        </span>
                      )}
                    </span>
                    <span className="hidden md:inline text-xs text-muted-foreground truncate">
                      {formatTrigger(r.trigger_source)}
                    </span>
                    <span className="hidden md:inline text-xs text-muted-foreground tabular-nums">
                      {formatDuration(r.duration_ms)}
                    </span>
                    <span className="hidden md:inline-flex">
                      <RunStatusCell status={r.status} />
                    </span>
                    <span className="hidden md:flex flex-col text-xs text-muted-foreground leading-tight">
                      <span className="text-foreground tabular-nums">{formatStartedTime(r)}</span>
                      <span>{formatRelative(getRunTimestamp(r))}</span>
                    </span>
                    <span className="md:hidden flex flex-col items-end gap-1 justify-end">
                      <RunStatusCell status={r.status} />
                      <span className="text-xs text-muted-foreground">{formatRelative(getRunTimestamp(r))}</span>
                    </span>
                  </Link>
                ))}
              </section>
            ))}
          </div>
          {(hasMore || currentPage > 1) && (
            <div className="flex items-center justify-between gap-3 px-1 py-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1 || loading}
                className="text-xs"
              >
                ← Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {currentPage}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage + 1)}
                disabled={!hasMore || loadingMore}
                className="text-xs"
              >
                {loadingMore ? "Loading..." : "Next →"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function groupRunsByDay(runs: RunSummary[]): Array<{ key: string; label: string; runs: RunSummary[] }> {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const timestamp = getRunTimestamp(run);
    const key = timestamp ? new Date(timestamp).toDateString() : "unknown";
    const existing = groups.get(key);
    if (existing) existing.push(run);
    else groups.set(key, [run]);
  }
  return Array.from(groups.entries()).map(([key, groupRuns]) => ({
    key,
    label: formatDayLabel(key),
    runs: groupRuns,
  }));
}

function getRunTimestamp(run: RunSummary): string | undefined {
  return run.started_at || run.created_at || run.completed_at;
}

function formatDayLabel(key: string): string {
  if (key === "unknown") return "Unscheduled";
  const date = new Date(key);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function formatRunCountSummary(runs: RunSummary[]): string {
  const failed = runs.filter((run) => run.status === "failed").length;
  const running = runs.filter((run) => run.status === "running" || run.status === "queued").length;
  const parts = [`${runs.length} ${runs.length === 1 ? "run" : "runs"}`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (running > 0) parts.push(`${running} active`);
  return parts.join(" · ");
}

function formatTrigger(triggerSource: string | undefined): string {
  if (!triggerSource || triggerSource === "manual") return "Manual";
  return titleCase(triggerSource.replace(/[_-]/g, " "));
}

function formatStartedTime(run: RunSummary): string {
  const timestamp = getRunTimestamp(run);
  if (!timestamp) return "-";
  return formatTimeOfDay(timestamp);
}

function summarizeError(error: string): string {
  const cleaned = error.replace(/\s+/g, " ").trim();
  // Raw dict / JSON with no "Error code:" prefix that the shared helper
  // doesn't recognise — pull the message out so the user never sees a raw
  // Python dict (audit P1).
  const dictMatch = cleaned.match(/Error code:\s*\d+\s*-\s*[{'"]/i);
  if (!dictMatch && (/^[{[]/.test(cleaned) || /['"]message['"]\s*:/.test(cleaned))) {
    const msgMatch = cleaned.match(/['"]message['"]\s*:\s*['"]([^'"]{1,200})['"]/i);
    if (msgMatch) {
      const msg = msgMatch[1].trim();
      return msg.length > 120 ? `${msg.slice(0, 117)}...` : msg;
    }
    if (/^[{[]/.test(cleaned)) return "Run failed (see run detail for the full error).";
  }
  // P1-4: machine error codes ("missing_connection: github",
  // "output_validation_failed: ...") + OpenAI dict wrappers -> human text.
  return humanizeRunError(cleaned);
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function RunStatusCell({ status }: { status: RunSummary["status"] }) {
  const normalized = status.replace(/_/g, " ");
  const isSuccess = SUCCESS_STATES.has(status.toLowerCase());
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <RunStatusGlyph status={status} className="size-3.5 shrink-0" />
      {isSuccess ? (
        <span className="font-medium text-foreground capitalize">{normalized}</span>
      ) : (
        <RunStatusBadge status={status} />
      )}
    </span>
  );
}

function formatDuration(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}
