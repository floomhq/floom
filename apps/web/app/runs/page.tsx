"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
// S27: dropped Card wrapper for the runs table (using bordered div with column header instead).
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RunStatusBadge } from "@/components/RunStatus";
import { formatRelative } from "@/lib/formatters";
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
          <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
          <p className="text-muted-foreground text-sm mt-1">All worker executions.</p>
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
        <div className="flex gap-1.5 flex-wrap">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => updateFilter("status", opt.value)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                statusFilter === opt.value
                  ? "bg-foreground text-background border-foreground"
                  : "bg-card text-muted-foreground border-border hover:border-muted-foreground/50"
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
        <div className="rounded-md border border-border bg-card overflow-hidden">
          {/* Column header row. Hidden on mobile (rows stack instead). */}
          <div className="hidden md:grid grid-cols-[1fr_120px_100px_140px_140px] gap-4 px-4 py-2 border-b border-line bg-[var(--bg-2)] text-[11px] uppercase tracking-wider font-medium text-muted-foreground">
            <span>Worker</span>
            <span>Trigger</span>
            <span>Duration</span>
            <span>Status</span>
            <span>Started</span>
          </div>
          {runs.map((r) => (
            <Link
              key={r.id}
              href={`/runs/${r.id}`}
              title={r.id}
              className="grid grid-cols-[1fr_auto] md:grid-cols-[1fr_120px_100px_140px_140px] gap-4 px-4 py-2.5 border-b border-line last:border-b-0 hover:bg-muted transition-colors items-center cursor-pointer"
            >
              <span className="text-sm font-medium truncate">{r.worker_name || r.worker_id}</span>
              <span className="hidden md:inline text-xs text-muted-foreground truncate">
                {r.trigger_source && r.trigger_source !== "manual" ? r.trigger_source : <span className="text-muted-foreground/50">manual</span>}
              </span>
              <span className="hidden md:inline text-xs text-muted-foreground tabular-nums">
                {formatDuration(r.duration_ms)}
              </span>
              <span className="hidden md:inline-flex">
                <RunStatusBadge status={r.status} />
              </span>
              <span className="hidden md:inline text-xs text-muted-foreground">
                {formatRelative(r.created_at)}
              </span>
              {/* Mobile fallback: single row on the right with status pill only */}
              <span className="md:hidden flex items-center gap-2 justify-end">
                <span className="text-xs text-muted-foreground">{formatRelative(r.created_at)}</span>
                <RunStatusBadge status={r.status} />
              </span>
            </Link>
          ))}
          {hasMore && (
            <div className="px-4 py-3 text-center border-t border-line">
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
