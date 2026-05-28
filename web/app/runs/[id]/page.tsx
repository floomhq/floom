"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { RunDetailSplitPane } from "@/components/RunDetailSplitPane";
import { api } from "@/lib/api";
import { useRunStream } from "@/lib/useRunStream";
import type { RunDetail } from "@/lib/types";

export default function RunDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const runId = id as string;
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const { parts, fallbackRun, connected, error, finishedPart } = useRunStream(runId);

  const load = useCallback(async () => {
    try {
      const detail = await api.runs.get(runId);
      setRun(detail);
    } catch (exc) {
      toast.error(exc instanceof Error ? exc.message : "Failed to load run");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (fallbackRun) {
      setRun(fallbackRun);
      setLoading(false);
    }
  }, [fallbackRun]);

  useEffect(() => {
    if (finishedPart) void load();
  }, [finishedPart, load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-[560px] w-full" />
      </div>
    );
  }

  if (!run) {
    return <div className="text-sm text-muted-foreground">Run not found.</div>;
  }

  return (
    <RunDetailSplitPane
      run={run}
      parts={parts}
      streamConnected={connected}
      streamError={error}
      onBack={() => router.push("/runs")}
      onReplay={async () => {
        try {
          const result = await api.runs.replay(run.worker_id, run.id);
          if (!result.run_id) throw new Error("Run ID missing from API response");
          toast.success("Re-running with same inputs");
          router.push(`/runs/${result.run_id}`);
        } catch (exc) {
          toast.error(`Re-run failed: ${exc instanceof Error ? exc.message : "unknown"}`);
        }
      }}
      onCancel={async () => {
        if (!confirm("Cancel this run?")) return;
        try {
          await api.runs.cancel(run.id);
          toast.success("Cancellation requested");
          void load();
        } catch (exc) {
          toast.error(`Cancel failed: ${exc instanceof Error ? exc.message : "unknown"}`);
        }
      }}
    />
  );
}
