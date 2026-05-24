"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Box, Play } from "lucide-react";
import type { WorkerSummary, ApprovalDetail } from "@/lib/types";

export default function WorkersPage() {
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalDetail[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.workers.list(),
      api.approvals.list("pending"),
    ]).then(([w, a]) => {
      setWorkers(w);
      setApprovals(a);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Count pending approvals per worker_id
  const pendingByWorker: Record<string, number> = {};
  for (const a of approvals) {
    pendingByWorker[a.worker_id] = (pendingByWorker[a.worker_id] || 0) + 1;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
          <p className="text-[#666] text-sm mt-1">All available workers. Select one to run it.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => api.workers.reload().then(() => window.location.reload())}>
          Reload workers
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {loading
          ? Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full" />
            ))
          : workers.map((w) => (
              <WorkerCard key={w.id} worker={w} pendingCount={pendingByWorker[w.id] || 0} />
            ))}
      </div>
    </div>
  );
}

function WorkerCard({ worker, pendingCount }: { worker: WorkerSummary; pendingCount: number }) {
  const statusColor: Record<string, string> = {
    healthy: "text-emerald-600 border-emerald-200 bg-emerald-50",
    needs_attention: "text-amber-600 border-amber-200 bg-amber-50",
    paused: "text-gray-500 border-gray-200 bg-gray-50",
    missing_secret: "text-amber-600 border-amber-200 bg-amber-50",
    error: "text-red-600 border-red-200 bg-red-50",
  };

  return (
    <Card className="border-[#eaeaea] shadow-none bg-white hover:border-[#d4d4d8] transition-colors">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Box className="w-4 h-4 text-[#999]" />
            <h3 className="font-medium text-[15px]">{worker.name}</h3>
          </div>
          <div className="flex items-center gap-1.5">
            {pendingCount > 0 && (
              <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50 text-xs">
                {pendingCount} pending
              </Badge>
            )}
            <Badge variant="outline" className={statusColor[worker.status] || statusColor.healthy}>
              {worker.status.replace("_", " ")}
            </Badge>
          </div>
        </div>
        <p className="text-sm text-[#666] line-clamp-2">{worker.description || "No description."}</p>
        <div className="flex items-center gap-3 text-xs text-[#999]">
          <span>Trigger: {worker.trigger_type}</span>
          <span>Runner: {worker.runner}</span>
        </div>
        {worker.last_run && (
          <p className="text-xs text-[#999]">
            Last run: {worker.last_run.created_at ? new Date(worker.last_run.created_at).toLocaleString() : "—"} · {worker.last_run.status}
          </p>
        )}
        <div className="pt-1">
          <Link href={`/workers/${worker.id}`}>
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
            >
              <Play className="w-3.5 h-3.5 mr-1.5" />
              {worker.status === "paused" ? "View (paused)" : "Run worker"}
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
