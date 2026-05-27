"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RunStatusBadge } from "@/components/RunStatus";
import { formatAbsolute, formatLogTime } from "@/lib/formatters";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, ChevronDown, ChevronRight, Copy, Download, Pencil, RotateCcw, Search, X } from "lucide-react";
import type { RunDetail, LogEntry, TranscriptRow } from "@/lib/types";
import { OutputRenderer } from "@/components/output-renderer";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Error pattern matching
// ---------------------------------------------------------------------------

function classifyError(err: string): { headline: string; raw: string } {
  const e = err || "";
  if (/OPENAI_API_KEY|api[_-]?key|AuthenticationError/i.test(e)) {
    return { headline: "OpenAI authentication failed. Check OPENAI_API_KEY in Secrets.", raw: e };
  }
  if (/rate_limit|RateLimitError/i.test(e)) {
    return { headline: "OpenAI rate limit hit. Wait a moment and retry.", raw: e };
  }
  if (/schema_violation/i.test(e)) {
    return { headline: "Worker output didn't match its declared schema. Check the run.py output keys against worker.yml.", raw: e };
  }
  if (/timeout|TimeoutError/i.test(e)) {
    return { headline: "Worker took too long. Consider breaking it into smaller steps.", raw: e };
  }
  if (/ModuleNotFoundError|ImportError/i.test(e)) {
    return { headline: `Worker dependency missing. Add it to requirements.txt.`, raw: e };
  }
  return { headline: "Worker failed. See raw error below.", raw: e };
}

// ---------------------------------------------------------------------------
// Step timing helper
// ---------------------------------------------------------------------------

function formatDelta(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60000) return `+${(ms / 1000).toFixed(1)}s`;
  return `+${Math.round(ms / 1000)}s`;
}

function computeDeltas(logs: LogEntry[]): (string | null)[] {
  return logs.map((log, i) => {
    if (i === 0) return null;
    try {
      const prev = new Date(logs[i - 1].timestamp).getTime();
      const curr = new Date(log.timestamp).getTime();
      const delta = curr - prev;
      if (isNaN(delta) || delta < 0) return null;
      return formatDelta(delta);
    } catch {
      return null;
    }
  });
}

function transcriptLabel(row: TranscriptRow): string {
  if (row.type === "tool_call") return `Tool call${row.name ? ` · ${row.name}` : ""}`;
  if (row.type === "tool_result") return `Tool result${row.name ? ` · ${row.name}` : ""}`;
  if (row.role) return row.role;
  return row.type || "entry";
}

function transcriptBody(row: TranscriptRow): string {
  if (row.type === "tool_call") {
    return JSON.stringify(row.arguments ?? {}, null, 2);
  }
  if (row.type === "tool_result") {
    return JSON.stringify(row.content ?? {}, null, 2);
  }
  if (typeof row.content === "string") return row.content;
  return JSON.stringify(row.content ?? row, null, 2);
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function RunDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [logSearch, setLogSearch] = useState("");
  const [rawErrorOpen, setRawErrorOpen] = useState(false);

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
      if (run && (run.status === "running" || run.status === "queued")) {
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

  // Log filtering
  const filteredLogs = logSearch.trim()
    ? run.logs.filter((l) => l.message.toLowerCase().includes(logSearch.toLowerCase()))
    : run.logs;

  // Step deltas (computed on full logs, indexed by original log idx)
  const allDeltas = computeDeltas(run.logs);

  // For filtered view we need the original index to get the right delta
  const filteredWithIdx = logSearch.trim()
    ? run.logs
        .map((l, i) => ({ log: l, origIdx: i }))
        .filter(({ log }) => log.message.toLowerCase().includes(logSearch.toLowerCase()))
    : run.logs.map((l, i) => ({ log: l, origIdx: i }));

  // Error classification
  const errorInfo = run.error ? classifyError(run.error) : null;
  const transcriptArtifact =
    run.runner?.startsWith("skill")
      ? run.artifacts.find((artifact) => artifact.name === "transcript.jsonl")
      : undefined;
  const transcriptRows = run.transcript || [];
  const hasTranscript = Boolean(transcriptArtifact && transcriptRows.length > 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push("/runs")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {run.worker_name || run.worker_id}
          </h1>
          <div className="flex items-center gap-2 mt-0.5">
            <code className="text-xs font-mono text-[#999]">{run.id}</code>
            <button
              type="button"
              title="Copy run ID"
              onClick={() => {
                navigator.clipboard.writeText(run.id).then(
                  () => toast.success("Run ID copied"),
                  () => toast.error("Failed to copy"),
                );
              }}
              className="text-[#bbb] hover:text-[#555] transition-colors"
            >
              <Copy className="w-3 h-3" />
            </button>
            <span className="text-xs text-[#999]">
              {formatAbsolute(run.created_at)}
            </span>
          </div>
        </div>
        <RunStatusBadge status={run.status} />
        {refreshing && <span className="text-xs text-[#999]">Refreshing...</span>}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/workers/${run.worker_id}?section=code`}>
              <Pencil className="w-3.5 h-3.5" />
              Edit worker
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const result = await api.runs.replay(run.worker_id, run.id);
                toast.success("Re-running with same inputs");
                router.push(`/runs/${result.run_id}`);
              } catch (e) {
                toast.error(
                  `Re-run failed: ${e instanceof Error ? e.message : "unknown"}`
                );
              }
            }}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Re-run
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={api.runs.downloadUrl(run.id)} download>
              <Download className="w-3.5 h-3.5" />
              Download all
            </a>
          </Button>
          {(run.status === "running" || run.status === "queued") && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (!confirm("Cancel this run?")) return;
                try {
                  await api.runs.cancel(run.id);
                  toast.success("Cancellation requested");
                } catch (e) {
                  toast.error(`Cancel failed: ${e instanceof Error ? e.message : "unknown"}`);
                }
              }}
            >
              Cancel run
            </Button>
          )}
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Run</TabsTrigger>
          {hasTranscript && <TabsTrigger value="transcript">Transcript</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-6">
              {/* Timeline with log search + step timings */}
              <Card className="border-[#eaeaea] shadow-none bg-white">
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="text-sm font-medium">Timeline</CardTitle>
                    <div className="relative flex-1 max-w-[200px]">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#aaa]" />
                      <Input
                        placeholder="Filter logs..."
                        value={logSearch}
                        onChange={(e) => setLogSearch(e.target.value)}
                        className="h-7 pl-7 pr-6 text-xs border-[#e4e4e7]"
                      />
                      {logSearch && (
                        <button
                          onClick={() => setLogSearch("")}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-[#aaa] hover:text-[#555]"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  {logSearch && (
                    <p className="text-xs text-[#999] mt-1">
                      {filteredLogs.length} of {run.logs.length} entries
                    </p>
                  )}
                </CardHeader>
                <CardContent className="space-y-2">
                  {run.logs.length === 0 ? (
                    <p className="text-sm text-[#999]">No logs yet.</p>
                  ) : filteredLogs.length === 0 ? (
                    <p className="text-sm text-[#999]">No entries match your filter.</p>
                  ) : (
                    filteredWithIdx.map(({ log, origIdx }) => (
                      <div key={origIdx} className="flex items-start gap-3 text-sm">
                        <span className="text-[#999] text-xs mt-0.5 min-w-[80px] shrink-0">
                          {formatLogTime(log.timestamp)}
                        </span>
                        <span className={`flex-1 ${log.level === "error" ? "text-red-600" : "text-[#333]"}`}>
                          {log.message}
                        </span>
                        {allDeltas[origIdx] && (
                          <span className="text-[#bbb] text-xs shrink-0">{allDeltas[origIdx]}</span>
                        )}
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

              {/* Structured error panel */}
              {run.status === "failed" && errorInfo && (
                <Card className="border-red-200 bg-red-50 shadow-none">
                  <CardContent className="p-5 space-y-3">
                    <p className="font-medium text-red-900">{errorInfo.headline}</p>
                    <button
                      onClick={() => setRawErrorOpen((v) => !v)}
                      className="flex items-center gap-1 text-xs text-red-600 hover:text-red-800"
                    >
                      {rawErrorOpen ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                      Raw error
                    </button>
                    {rawErrorOpen && (
                      <pre className="text-xs text-red-700 whitespace-pre-wrap bg-red-100 p-3 rounded-md overflow-auto max-h-[200px]">
                        {errorInfo.raw}
                      </pre>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Non-failed errors */}
              {run.error && run.status !== "failed" && (
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
        </TabsContent>

        {hasTranscript && (
          <TabsContent value="transcript">
            <Card className="border-[#eaeaea] shadow-none bg-white">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Transcript</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {transcriptRows.length === 0 ? (
                  <p className="text-sm text-[#999]">No transcript entries.</p>
                ) : (
                  transcriptRows.map((row, index) => (
                    <div key={index} className="rounded-md border border-[#eaeaea] bg-[#fafafa] p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="text-xs font-medium uppercase tracking-wide text-[#666]">
                          {transcriptLabel(row)}
                        </span>
                        {row.tool_call_id && (
                          <span className="text-[11px] text-[#999]">{row.tool_call_id}</span>
                        )}
                      </div>
                      <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-[#333]">
                        {transcriptBody(row)}
                      </pre>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// PR S12-UI-dry: local StatusBadge removed, callers use <RunStatusBadge>.
