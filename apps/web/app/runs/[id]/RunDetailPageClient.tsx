"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RunDetailSplitPane } from "@/components/RunDetailSplitPane";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useRunStream } from "@/lib/useRunStream";
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

export default function RunDetailPageClient({
  runId,
  initialTab,
}: {
  runId: string;
  initialTab?: string;
}) {
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
      window.location.href = `/runs/${encodeURIComponent(result.run_id)}?tab=logs`;
    } catch (exc) {
      toast.error(exc instanceof Error ? exc.message : "Could not replay run");
    }
  }, [run]);

  if (loading && !run) {
    return (
      <div className="flex min-h-[320px] items-center justify-center text-sm text-muted-foreground">
        Loading run...
      </div>
    );
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
