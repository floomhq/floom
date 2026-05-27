"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ChevronRight, Download, Play } from "lucide-react";
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
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [workerFilter, setWorkerFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

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
        <Button
          variant="outline"
          size="sm"
          onClick={exportCSV}
          disabled={runs.length === 0}
          className="gap-1.5"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        <Select value={workerFilter} onValueChange={(v) => setWorkerFilter(v ?? "")}>
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
              onClick={() => setStatusFilter(opt.value)}
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

      <Card className="border-border shadow-none bg-card">
        <CardHeader>
          <CardTitle className="text-sm font-medium">History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)
          ) : runs.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-3 text-center">
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
                  onClick={() => { setWorkerFilter(""); setStatusFilter(""); }}
                  className="text-xs text-muted-foreground hover:text-foreground underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <>
              {runs.map((r) => (
                <Link
                  key={r.id}
                  href={`/runs/${r.id}`}
                  className="flex items-center justify-between p-3 rounded-md hover:bg-muted transition-colors cursor-pointer"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{r.worker_name || r.worker_id}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      <span className="font-mono text-[10px]">{r.id}</span>
                      <span className="text-muted-foreground/60 mx-1">·</span>
                      <span className="text-muted-foreground">{r.trigger_source} · {formatRelative(r.created_at)}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <RunStatusBadge status={r.status} />
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                </Link>
              ))}
              {hasMore && (
                <div className="pt-2 text-center">
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
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// PR S12-UI-dry: local StatusBadge removed, callers use <RunStatusBadge>
// from @/components/RunStatus instead.
