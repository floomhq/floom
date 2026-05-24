"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import Papa from "papaparse";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Box, Clock, AlertTriangle, Download } from "lucide-react";
import type { WorkerSummary, RunSummary } from "@/lib/types";

export default function OverviewPage() {
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [w, r] = await Promise.all([
          api.workers.list(),
          api.runs.list({ limit: 5 }),
        ]);
        setWorkers(w);
        setRuns(r);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const API_PAGE_MAX = 500;

  async function exportAllRuns() {
    try {
      let allRuns: typeof runs = [];
      let offset = 0;
      while (true) {
        const page = await api.runs.list({ limit: API_PAGE_MAX, offset });
        allRuns = [...allRuns, ...page];
        if (page.length < API_PAGE_MAX) break;
        offset += API_PAGE_MAX;
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
      a.download = `workeros-all-runs-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    }
  }

  const runsToday = runs.filter((r) => {
    if (!r.created_at) return false;
    const d = new Date(r.created_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  const failedRuns = runs.filter((r) => r.status === "failed").length;

  const stats = [
    { label: "Workers", value: workers.length, icon: Box },
    { label: "Runs today", value: runsToday, icon: Clock },
    { label: "Failed", value: failedRuns, icon: AlertTriangle },
  ];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-[#666] text-sm mt-1">What is running and what needs attention.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={exportAllRuns}
          className="gap-1.5"
        >
          <Download className="w-4 h-4" />
          Export all runs
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {stats.map((s) => (
          <Card key={s.label} className="shadow-none border-[#eaeaea] bg-white">
            <CardContent className="p-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-[#666]">
                  {s.label}
                </p>
                <div className="text-2xl font-semibold mt-1">
                  {loading ? <Skeleton className="h-8 w-12" /> : s.value}
                </div>
              </div>
              <s.icon className="w-5 h-5 text-[#999]" />
            </CardContent>
          </Card>
        ))}
      </div>

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
                  <p className="text-xs text-[#999] mt-0.5">{r.trigger_source} · {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}</p>
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
    queued: "text-gray-600 border-gray-200 bg-gray-50",
  };
  return (
    <Badge variant="outline" className={map[status] || map.queued}>
      {status.replace("_", " ")}
    </Badge>
  );
}
