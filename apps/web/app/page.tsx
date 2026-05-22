"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Box, Clock, AlertTriangle, ShieldCheck } from "lucide-react";
import type { Worker, RunSummary, Approval } from "@/lib/types";

export default function OverviewPage() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [w, r, a] = await Promise.all([
          api.workers.list(),
          api.runs.list({ limit: 5 }),
          api.approvals.list("pending"),
        ]);
        setWorkers(w);
        setRuns(r);
        setApprovals(a);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const runsToday = runs.filter((r) => {
    const d = new Date(r.created_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  const failedRuns = runs.filter((r) => r.status === "failed").length;

  const stats = [
    { label: "Workers", value: workers.length, icon: Box },
    { label: "Runs today", value: runsToday, icon: Clock },
    { label: "Failed", value: failedRuns, icon: AlertTriangle },
    { label: "Pending approvals", value: approvals.length, icon: ShieldCheck },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-[#666] text-sm mt-1">What is running and what needs attention.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <Card key={s.label} className="border-[#eaeaea] shadow-none bg-white">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-[#666] text-xs font-medium uppercase tracking-wide">{s.label}</p>
                <p className="text-2xl font-semibold mt-1">{loading ? <Skeleton className="h-8 w-12" /> : s.value}</p>
              </div>
              <s.icon className="w-5 h-5 text-[#999]" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border-[#eaeaea] shadow-none bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Recent runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {loading ? (
              <Skeleton className="h-20 w-full" />
            ) : runs.length === 0 ? (
              <p className="text-sm text-[#999]">No runs yet.</p>
            ) : (
              runs.map((r) => (
                <Link
                  key={r.id}
                  href={`/runs/${r.id}`}
                  className="flex items-center justify-between p-3 rounded-md hover:bg-[#f4f4f5] transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium">{r.worker_name || r.worker_id}</p>
                    <p className="text-xs text-[#999] mt-0.5">{r.trigger_source} · {new Date(r.created_at).toLocaleString()}</p>
                  </div>
                  <StatusBadge status={r.status} />
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-[#eaeaea] shadow-none bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Pending approvals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {loading ? (
              <Skeleton className="h-20 w-full" />
            ) : approvals.length === 0 ? (
              <p className="text-sm text-[#999]">No pending approvals.</p>
            ) : (
              approvals.map((a) => (
                <Link
                  key={a.id}
                  href={`/runs/${a.run_id}`}
                  className="flex items-center justify-between p-3 rounded-md hover:bg-[#f4f4f5] transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium">{a.worker_name || a.worker_id}</p>
                    <p className="text-xs text-[#999] mt-0.5 truncate max-w-xs">{a.label}</p>
                  </div>
                  <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50">
                    Pending
                  </Badge>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>
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
