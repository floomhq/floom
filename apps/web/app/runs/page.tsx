"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { RunSummary } from "@/lib/types";

export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.runs.list({ limit: 50 }).then((r) => {
      setRuns(r);
      setLoading(false);
    });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <p className="text-[#666] text-sm mt-1">All worker executions.</p>
      </div>

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardHeader>
          <CardTitle className="text-sm font-medium">History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)
          ) : runs.length === 0 ? (
            <p className="text-sm text-[#999]">No runs yet.</p>
          ) : (
            runs.map((r) => (
              <Link
                key={r.id}
                href={`/runs/${r.id}`}
                className="flex items-center justify-between p-3 rounded-md hover:bg-[#f4f4f5] transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.worker_name || r.worker_id}</p>
                  <p className="text-xs text-[#999] mt-0.5">
                    {r.id} · {r.trigger_source} · {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                  </p>
                </div>
                <StatusBadge status={r.status} />
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    running: "text-blue-600 border-blue-200 bg-blue-50",
    completed: "text-emerald-600 border-emerald-200 bg-emerald-50",
    failed: "text-red-600 border-red-200 bg-red-50",
    pending_approval: "text-amber-600 border-amber-200 bg-amber-50",
    approved: "text-emerald-600 border-emerald-200 bg-emerald-50",
    rejected: "text-red-600 border-red-200 bg-red-50",
    queued: "text-gray-600 border-gray-200 bg-gray-50",
  };
  return (
    <Badge variant="outline" className={map[status] || map.queued}>
      {status.replace("_", " ")}
    </Badge>
  );
}
