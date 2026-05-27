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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ArrowLeft, ChevronRight, Copy, Download, Pencil, RotateCcw, Search, X } from "lucide-react";
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
  // PR S19 (I-30): rawErrorOpen state retired with the redesign — Error panel
  // shows the raw error inline by default now.

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
    return <div className="text-sm text-muted-foreground">Run not found.</div>;
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
            <code className="text-xs font-mono text-muted-foreground">{run.id}</code>
            <button
              type="button"
              title="Copy run ID"
              onClick={() => {
                navigator.clipboard.writeText(run.id).then(
                  () => toast.success("Run ID copied"),
                  () => toast.error("Failed to copy"),
                );
              }}
              className="text-muted-foreground hover:text-muted-foreground transition-colors"
            >
              <Copy className="w-3 h-3" />
            </button>
            <span className="text-xs text-muted-foreground">
              {formatAbsolute(run.created_at)}
            </span>
          </div>
        </div>
        <RunStatusBadge status={run.status} />
        {refreshing && <span className="text-xs text-muted-foreground">Refreshing...</span>}
        <div className="flex items-center gap-2">
          <Link href={`/workers/${run.worker_id}?section=code`}>
            <Button variant="outline" size="sm">
              <Pencil className="w-3.5 h-3.5" />
              Edit worker
            </Button>
          </Link>
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
          <a href={api.runs.downloadUrl(run.id)} download>
            <Button variant="outline" size="sm">
              <Download className="w-3.5 h-3.5" />
              Download all
            </Button>
          </a>
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

      {/* PR S19 (I-30): rewrite to match the locked ASCII spec.
          Output is the primary visual weight at top, full width. Below it,
          three collapsibles (Inputs / Logs / Artifacts). Failed runs swap
          the Output panel for a red Error panel of the same shape. */}

      {run.status === "failed" && errorInfo ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive flex items-center gap-2">
              Error
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm font-medium">{errorInfo.headline}</p>
            <pre className="text-xs text-destructive/90 whitespace-pre-wrap bg-destructive/10 p-3 rounded-md overflow-auto max-h-[260px]">
              {errorInfo.raw}
            </pre>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Output</CardTitle>
          </CardHeader>
          <CardContent>
            {(!run.output_schema || run.output_schema.length === 0) && Object.keys(run.output || {}).length === 0 ? (
              <p className="text-sm text-muted-foreground">No output yet.</p>
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
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{key}</p>
                    <div className="bg-muted p-3 rounded-md text-sm whitespace-pre-wrap font-mono leading-relaxed">
                      {String(value)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-muted-foreground transition-colors">
          <ChevronRight className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
          Inputs
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-[280px]">
            {JSON.stringify(run.input, null, 2)}
          </pre>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-muted-foreground transition-colors">
          <ChevronRight className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
          Logs ({run.logs.length})
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3 space-y-2">
          {run.logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No logs yet.</p>
          ) : (
            <>
              <div className="relative max-w-sm">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  placeholder="Filter logs..."
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                  className="h-7 pl-7 pr-6 text-xs"
                />
                {logSearch && (
                  <button
                    onClick={() => setLogSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div className="space-y-1 max-h-[420px] overflow-auto">
                {filteredWithIdx.map(({ log, origIdx }) => (
                  <div key={origIdx} className="flex items-start gap-3 text-sm">
                    <span className="text-muted-foreground text-xs mt-0.5 min-w-[80px] shrink-0 font-mono">
                      {formatLogTime(log.timestamp)}
                    </span>
                    <span className={`flex-1 ${log.level === "error" ? "text-red-600" : "text-foreground"}`}>
                      {log.message}
                    </span>
                    {allDeltas[origIdx] && (
                      <span className="text-muted-foreground text-xs shrink-0">{allDeltas[origIdx]}</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </CollapsibleContent>
      </Collapsible>

      {run.artifacts.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-muted-foreground transition-colors">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
            Artifacts ({run.artifacts.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3 space-y-2">
            {run.artifacts.map((a) => {
              const downloadUrl = `/api/proxy/runs/${run.id}/artifacts/${a.id}/download`;
              return (
                <div key={a.id} className="flex items-center justify-between p-2 rounded-md bg-muted">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm truncate">{a.name}</span>
                    {a.type && <span className="text-xs text-muted-foreground shrink-0">{a.type}</span>}
                    {a.size_bytes != null && (
                      <span className="text-xs text-muted-foreground shrink-0">{Math.round(a.size_bytes / 1024)}KB</span>
                    )}
                  </div>
                  <a
                    href={downloadUrl}
                    download={a.name}
                    className="text-xs text-foreground hover:underline ml-2 shrink-0"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Download
                  </a>
                </div>
              );
            })}
          </CollapsibleContent>
        </Collapsible>
      )}

      {hasTranscript && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-muted-foreground transition-colors">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
            Transcript ({transcriptRows.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3 space-y-3">
            {transcriptRows.map((row, index) => (
              <div key={index} className="rounded-md border bg-muted/30 p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {transcriptLabel(row)}
                  </span>
                  {row.tool_call_id && (
                    <span className="text-[11px] text-muted-foreground">{row.tool_call_id}</span>
                  )}
                </div>
                <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
                  {transcriptBody(row)}
                </pre>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

// PR S12-UI-dry: local StatusBadge removed, callers use <RunStatusBadge>.
