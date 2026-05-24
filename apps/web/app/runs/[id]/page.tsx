"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft } from "lucide-react";
import type { RunDetail } from "@/lib/types";
import { OutputRenderer } from "@/components/output-renderer";

export default function RunDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.runs.get(id as string);
      setRun(r);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => {
      if (run && (run.status === "running" || run.status === "queued" || run.status === "pending_approval")) {
        setRefreshing(true);
        void load();
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [id, run, load]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!run) {
    return <div className="text-sm text-[#999]">Run not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push("/runs")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{run.id}</h1>
          <p className="text-[#666] text-sm">
            {run.worker_name || run.worker_id} · {run.created_at ? new Date(run.created_at).toLocaleString() : "—"}
          </p>
        </div>
        <StatusBadge status={run.status} />
        {refreshing && <span className="text-xs text-[#999]">Refreshing...</span>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Timeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {run.logs.length === 0 ? (
                <p className="text-sm text-[#999]">No logs yet.</p>
              ) : (
                run.logs.map((log, i) => (
                  <div key={i} className="flex items-start gap-3 text-sm">
                    <span className="text-[#999] text-xs mt-0.5 min-w-[80px]">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <span className={log.level === "error" ? "text-red-600" : "text-[#333]"}>{log.message}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Input</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs bg-[#f4f4f5] p-3 rounded-md overflow-auto">
                {JSON.stringify(run.input, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Output</CardTitle>
            </CardHeader>
            <CardContent>
              {(!run.output_schema || run.output_schema.length === 0) && Object.keys(run.output || {}).length === 0 ? (
                <p className="text-sm text-[#999]">No output yet.</p>
              ) : run.output_schema && run.output_schema.length > 0 ? (
                <div className="space-y-6">
                  {run.output_schema.map((field) => (
                    <OutputRenderer key={field.name} field={field} runId={run.id} />
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  {Object.entries(run.output).map(([key, value]) => (
                    <div key={key}>
                      <p className="text-xs font-medium text-[#666] uppercase tracking-wide mb-1">{key}</p>
                      <div className="bg-[#f4f4f5] p-3 rounded-md text-sm whitespace-pre-wrap font-mono leading-relaxed">
                        {String(value)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {run.error && (
            <Card className="border-red-200 bg-red-50 shadow-none">
              <CardHeader>
                <CardTitle className="text-sm font-medium text-red-800">Error</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-xs text-red-700 whitespace-pre-wrap">{run.error}</pre>
              </CardContent>
            </Card>
          )}

          {run.artifacts.length > 0 && (
            <Card className="border-[#eaeaea] shadow-none bg-white">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Artifacts</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {run.artifacts.map((a) => {
                  const downloadUrl = `/api/proxy/runs/${run.id}/artifacts/${a.id}/download`;
                  return (
                    <div key={a.id} className="flex items-center justify-between p-2 rounded-md bg-[#f4f4f5]">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm truncate">{a.name}</span>
                        {a.type && <span className="text-xs text-[#999] shrink-0">{a.type}</span>}
                        {a.size_bytes != null && (
                          <span className="text-xs text-[#999] shrink-0">{Math.round(a.size_bytes / 1024)}KB</span>
                        )}
                      </div>
                      <a
                        href={downloadUrl}
                        download={a.name}
                        className="text-xs text-blue-600 hover:underline ml-2 shrink-0"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Download
                      </a>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>
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
