"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
// S27: dropped Card wrapper for the runs table (using bordered div with column header instead).
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RunStatusBadge, RunStatusGlyph } from "@/components/RunStatus";
import { WorkerAvatar } from "@/components/WorkerAvatar";
import { formatRelative, formatTimeOfDay } from "@/lib/formatters";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Download, Play } from "lucide-react";
import type { RunSummary, WorkerSummary } from "@/lib/types";

const STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const PAGE_SIZE = 20;
const SUCCESS_STATES = new Set(["completed", "success", "succeeded"]);

export default function RunsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Loading runs...</div>}>
      <RunsContent />
    </Suspense>
  );
}

function RunsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // S22e: filter state lives in the URL (?status=failed&worker_id=foo) so
  // links are shareable, refresh preserves filters, and back-button works.
  const workerFilter = searchParams.get("worker_id") ?? "";
  const statusFilter = searchParams.get("status") ?? "";

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const updateFilter = useCallback((key: "status" | "worker_id", value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.replace(`/runs${params.size ? `?${params.toString()}` : ""}`, { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    api.workers.list().then(setWorkers).catch(() => {});
  }, []);

  useEffect(() => {
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

  function loadMore() {
    const next = offset + PAGE_SIZE;
    setOffset(next);
    fetchRuns(next);
  }

  const groupedRuns = groupRunsByDay(runs);

  const API_PAGE_MAX = 500; // API enforced maximum per page

  async function exportCSV() {
    // Fetch ALL rows matching the current filter by paginating through the API
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
        if (page.length < API_PAGE_MAX) break; // last page
        offset += API_PAGE_MAX;
      }
    } catch {
      allRuns = runs; // fallback to loaded runs on error
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Run history</h1>
          <p className="text-muted-foreground text-sm mt-1">Worker executions grouped by day.</p>
        </div>
        {/* S22e: Export demoted to ghost (roast P1: was as loud as primary
            New worker CTA elsewhere; export is a power-user destination). */}
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

      {/* Filters. S22e: filter state synced to URL so ?status=failed
          is shareable + refresh preserves filters + back-button works. */}
      <div className="flex gap-3 flex-wrap items-center">
        <Select value={workerFilter} onValueChange={(v) => updateFilter("worker_id", v ?? "")}>
          <SelectTrigger className="w-[200px] text-sm h-8">
            <SelectValue placeholder="All workers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All workers</SelectItem>
            {workers.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* S29q: was 5 saturated pill buttons (All/Queued/Running/Completed/
            Failed) styled like primaries — looked like 5 CTAs on one screen.
            Now quiet text-only with a colored underline on the active option.
            Same visual register as the tabs and /runs/<id> Transcript/Logs/
            Output bar. */}
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

      {/* S27: table-style density. Drops the "History" Card+CardTitle
          wrapper, replaces vertical card-rows with a real columnar table:
          Worker | Trigger | Duration | Status | Started. Click row to
          navigate to /runs/<id>. */}
      {loading ? (
        <div className="rounded-md border border-border bg-card overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-none border-b border-line last:border-b-0" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-md border border-border bg-card py-12 flex flex-col items-center gap-3 text-center">
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
          {groupedRuns.map((group) => (
            <section key={group.key} className="rounded-md border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-line bg-[var(--bg-2)]">
                <h2 className="text-xs font-semibold uppercase text-muted-foreground">
                  {group.label}
                </h2>
                <span className="text-[11px] text-muted-foreground">
                  {formatRunCountSummary(group.runs)}
                </span>
              </div>
              <div className="hidden md:grid grid-cols-[minmax(0,1fr)_120px_110px_150px_160px] gap-4 px-4 py-2 border-b border-line text-[11px] font-medium text-muted-foreground">
                <span>Worker</span>
                <span>Trigger</span>
                <span>Duration</span>
                <span>Status</span>
                <span>Started</span>
              </div>
              {group.runs.map((r) => (
                <Link
                  key={r.id}
                  href={`/runs/${r.id}`}
                  title={r.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_120px_110px_150px_160px] gap-4 px-4 py-3 border-b border-line last:border-b-0 hover:bg-muted transition-colors items-center cursor-pointer"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2.5 min-w-0">
                      <WorkerAvatar seed={r.worker_id} name={r.worker_name || r.worker_id} size="size-6" />
                      <span className="text-sm font-medium truncate">{r.worker_name || r.worker_id}</span>
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
          {hasMore && (
            <div className="px-4 py-3 text-center rounded-md border border-border bg-card">
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
                className="text-xs"
              >
                {loadingMore ? "Loading..." : "Load more"}
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
  if (cleaned.length <= 120) return cleaned;
  return `${cleaned.slice(0, 117)}...`;
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

// PR S12-UI-dry: local StatusBadge removed, callers use <RunStatusBadge>
// from @/components/RunStatus instead.
