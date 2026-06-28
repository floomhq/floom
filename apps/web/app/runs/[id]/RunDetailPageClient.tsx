"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RunDetailSplitPane } from "@/components/RunDetailSplitPane";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useRunStream } from "@/lib/useRunStream";
import { useWorkspaceHref } from "@/lib/useWorkspaceHref";
import type { RunDetail } from "@/lib/types";

const VALID_TABS = new Set([
  "output",
  "inputs",
  "transcript",
  "tool-calls",
  "approval",
  "files",
  "logs",
  "raw",
  "metadata",
]);

function normalizeInitialTab(tab: string | undefined): string {
  if (!tab) return "output";
  const normalized = tab.toLowerCase();
  return VALID_TABS.has(normalized) ? normalized : "output";
}

function RunDetailLoadingSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading run details">
      <Skeleton className="h-5 w-20 rounded-[var(--radius-button)]" />
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-7 w-72 max-w-full rounded-[var(--radius-button)]" />
            <Skeleton className="h-6 w-20 rounded-[var(--radius-pill)]" />
          </div>
          <Skeleton className="h-4 w-96 max-w-full rounded-[var(--radius-button)]" />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Skeleton className="h-9 w-28 rounded-[var(--radius-button)]" />
          <Skeleton className="h-9 w-24 rounded-[var(--radius-button)]" />
          <Skeleton className="h-9 w-28 rounded-[var(--radius-button)]" />
        </div>
      </div>
      <dl className="grid gap-px overflow-hidden rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--border-default)] text-sm sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
        {["Status", "Started", "Duration", "Tokens", "Cost", "Output", "Files"].map((label) => (
          <div key={label} className="min-w-0 bg-card px-3 py-2">
            <dt className="text-[11px] font-medium uppercase text-muted-foreground">{label}</dt>
            <Skeleton className="mt-1 h-5 w-24 rounded-[var(--radius-button)]" />
          </div>
        ))}
      </dl>
      <div className="flex min-h-[320px] flex-col overflow-hidden rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] md:flex-row">
        <aside className="w-full shrink-0 [border-bottom:var(--bd-div)] bg-muted/25 p-3 md:w-[280px] md:[border-right:var(--bd-div)] md:[border-bottom:0]">
          {[0, 1, 2].map((idx) => (
            <div key={idx} className="flex gap-2 pb-3">
              <Skeleton className="size-4 shrink-0 rounded-[var(--radius-pill)]" />
              <div className="min-w-0 flex-1 space-y-1">
                <Skeleton className="h-4 w-36 rounded-[var(--radius-button)]" />
                <Skeleton className="h-3 w-48 max-w-full rounded-[var(--radius-button)]" />
              </div>
            </div>
          ))}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex gap-2 [border-bottom:var(--bd-div)] px-3 py-2">
            {["Output", "Inputs", "Activity", "Files", "Logs"].map((label) => (
              <Skeleton key={label} className="h-8 w-20 rounded-[var(--radius-button)]" />
            ))}
          </div>
          <div className="space-y-3 p-4">
            <Skeleton className="h-24 w-full rounded-[var(--radius-card)]" />
            <Skeleton className="h-4 w-2/3 rounded-[var(--radius-button)]" />
            <Skeleton className="h-4 w-1/2 rounded-[var(--radius-button)]" />
          </div>
        </main>
      </div>
    </div>
  );
}

export default function RunDetailPageClient({
  runId,
  initialTab,
}: {
  runId: string;
  initialTab?: string;
}) {
  const workspaceHref = useWorkspaceHref();
  const {
    parts,
    fallbackRun,
    connected,
    error,
    finishedPart,
    streamUnavailable,
    refresh,
  } = useRunStream(runId);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadRun = useCallback(async () => {
    setLoadError(null);
    try {
      const detail = await api.runs.get(runId);
      setRun(detail);
    } catch (exc) {
      setLoadError(exc instanceof Error ? exc.message : "Could not load run.");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    setLoading(true);
    void loadRun();
  }, [loadRun]);

  useEffect(() => {
    if (fallbackRun) setRun(fallbackRun);
  }, [fallbackRun]);

  useEffect(() => {
    if (!finishedPart) return;
    void loadRun();
  }, [finishedPart, loadRun]);

  const handleRefresh = useCallback(() => {
    refresh();
    void loadRun();
  }, [loadRun, refresh]);

  const handleCancel = useCallback(async () => {
    try {
      await api.runs.cancel(runId);
      toast.success("Run cancelled");
      handleRefresh();
    } catch (exc) {
      toast.error(exc instanceof Error ? exc.message : "Could not cancel run");
    }
  }, [handleRefresh, runId]);

  const handleReplay = useCallback(async () => {
    if (!run) return;
    try {
      const result = await api.runs.replay(run.worker_id, run.id);
      toast.success("Replay started");
      window.location.href = workspaceHref(`/runs/${encodeURIComponent(result.run_id)}?tab=logs`);
    } catch (exc) {
      toast.error(exc instanceof Error ? exc.message : "Could not replay run");
    }
  }, [run, workspaceHref]);

  if (loading && !run) {
    return <RunDetailLoadingSkeleton />;
  }

  if (loadError && !run) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" onClick={handleRefresh}>
          Retry
        </Button>
      </div>
    );
  }

  if (!run) return null;

  return (
    <RunDetailSplitPane
      run={run}
      parts={parts}
      streamConnected={connected}
      streamError={error}
      streamUnavailable={streamUnavailable}
      onRefresh={handleRefresh}
      initialTab={normalizeInitialTab(initialTab)}
      onCancel={handleCancel}
      onReplay={handleReplay}
    />
  );
}
