"use client";

import { useState } from "react";
import Link from "next/link";
import { Copy, Check, Download, FileText, Pencil, RotateCcw, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RunStatusBadge, RunStatusGlyph } from "@/components/RunStatus";
import { Tool } from "@/components/ai-elements/tool";
import { Terminal } from "@/components/ai-elements/terminal";
import { StackTrace } from "@/components/ai-elements/stack-trace";
import { Task } from "@/components/ai-elements/task";
import { OutputRenderer } from "@/components/output-renderer";
import { GenericOutput } from "@/components/generic-output";
import { api } from "@/lib/api";
import { formatAbsolute } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import {
  humanizeKey,
  humanizeRunError,
  humanizeLogMessage,
  operatorLogs,
  isExportSuccessKey,
  exportSuccessState,
  exportStateText,
} from "@/lib/run-format";
import { stripCitationTokens } from "@/lib/strip-citations";
import type { LogEntry, RunDetail, RunPart, TranscriptRow, ToolCallEntry, ApprovalEntry } from "@/lib/types";

type Props = {
  run: RunDetail;
  parts?: RunPart[];
  streamConnected?: boolean;
  streamError?: string | null;
  streamUnavailable?: boolean;
  onRefresh?: () => void;
  inline?: boolean;
  initialTab?: string;
  onBack?: () => void;
  onReplay?: () => void;
  onCancel?: () => void;
};

export function RunDetailSplitPane({
  run,
  parts = [],
  streamConnected = false,
  streamError,
  streamUnavailable = false,
  onRefresh,
  inline = false,
  initialTab = "output",
  onBack,
  onReplay,
  onCancel,
}: Props) {
  const transcriptParts = parts.length > 0 ? parts : partsFromRun(run);
  const timeline = buildTimeline(run, transcriptParts);
  const isActive = run.status === "running" || run.status === "queued";
  const latest = latestStatus(run, transcriptParts);
  const displayStatus = streamUnavailable && isActive ? "unknown" : latest;

  return (
    <div className={cn("space-y-6", inline && "min-h-[280px]")}>
      {/* S29h (F8.1): match /workers/<id> chrome exactly. Drop the
          sticky/backdrop/border-b header pattern (no other page has it),
          drop the border-x box around the split pane. Header is now flat
          with the same flex/gap/padding rhythm as /workers/<id>. */}
      {!inline && (
        <Link
          href="/runs"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <span aria-hidden="true">←</span>
          Runs
        </Link>
      )}
      <div className="flex flex-col items-start gap-3 sm:flex-row">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/workers?sel=${encodeURIComponent(run.worker_id)}`}
              className={cn("min-w-0 break-words font-semibold tracking-tight sm:truncate hover:underline", inline ? "text-base" : "text-xl")}
            >
              {run.worker_name || run.worker_id}
            </Link>
            <RunStatusBadge status={displayStatus} />
            {streamConnected && <span className="text-xs text-pending">Streaming</span>}
            {streamError && <span className="text-xs text-error">{streamError}</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <code className="font-mono">{run.id}</code>
            <button
              type="button"
              title="Copy run ID"
              className="rounded p-0.5 hover:bg-muted"
              onClick={() => {
                navigator.clipboard.writeText(run.id).then(
                  () => toast.success("Run ID copied"),
                  () => toast.error("Copy failed"),
                );
              }}
            >
              <Copy className="size-3" />
            </button>
            {run.created_at && (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span>{formatAbsolute(run.created_at)}</span>
              </>
            )}
            {run.duration_ms != null && (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span>{formatDuration(run.duration_ms)}</span>
              </>
            )}
            {run.total_tokens != null && (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span>{run.total_tokens.toLocaleString()} tokens</span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* N27: was "Edit" — misleading in run-detail context (users expected to
              edit the run, not the worker source). Relabelled "Edit worker" and
              link lands on the worker Source tab (same destination as before). */}
          <Link href={`/workers?sel=${encodeURIComponent(run.worker_id)}&tab=Source`}>
            <Button variant="outline" size="sm">
              <Pencil className="size-3.5 mr-1.5" />
              Edit worker
            </Button>
          </Link>
          {run.can_replay !== false && (
            /* #1274: confirm before replaying to prevent accidental duplicate runs. */
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!window.confirm("Re-run this worker with the same inputs?")) return;
                onReplay?.();
              }}
            >
              <RotateCcw className="size-3.5 mr-1.5" />
              Re-run
            </Button>
          )}
          <a href={api.runs.downloadUrl(run.id)} download>
            <Button variant="outline" size="sm">
              <Download className="size-3.5 mr-1.5" />
              Download
            </Button>
          </a>
          {isActive && (
            <Button variant="outline" size="sm" onClick={onCancel}>
              <Square className="size-3.5 mr-1.5" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {streamUnavailable && isActive && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--ink)]">Run status connection lost</p>
            <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
              {streamError || "The stream dropped before a terminal event arrived. Refresh to check the backend."}
            </p>
          </div>
          {onRefresh && (
            <Button variant="outline" size="sm" onClick={onRefresh}>
              <RotateCcw className="size-3.5 mr-1.5" />
              Refresh status
            </Button>
          )}
        </div>
      )}

      <RunMetricsStrip run={run} status={displayStatus} />

      {/* R4: the split pane was unbounded — long transcripts/logs grew the
          whole page so it scrolled "into infinity". Cap the pane at a
          viewport-relative height and let each pane scroll WITHIN itself. */}
      <div className="flex min-h-[280px] max-h-[calc(100vh-13rem)] flex-col gap-0 overflow-hidden rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] md:flex-row">
        {/* R5 (2026-05-30): the timeline pane previously had `md:resize-x` (a
            CSS textarea-style drag handle showed in its corner) and
            `md:max-h-none`, which stretched a short timeline into a huge empty
            box reserving dead vertical height. Drop the resize affordance and
            let the pane size to its content (self-scroll only when long). */}
        <aside className="max-h-44 w-full shrink-0 self-start overflow-y-auto [border-bottom:var(--bd-div)] bg-muted/25 md:max-h-[calc(100vh-13rem)] md:w-[320px] md:min-w-[240px] md:max-w-[460px] md:[border-right:var(--bd-div)] md:[border-bottom:0]">
          {/* S29q: dropped the SMALL-CAPS "TIMELINE" panel label entirely.
              The timeline IS the panel; the label was dead weight (ChatGPT
              audit P-1). */}
          <div className="p-2">
            {timeline.map((item, index) => (
              <TimelineRow key={`${item.label}-${index}`} item={item} />
            ))}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* v6: lead with the rendered OUTPUT (the generic viewer). The
          transcript/logs/files/raw/metadata are secondary tabs, not a
          vertical scroll-pile. The caller chooses the default tab. */}
          <Tabs defaultValue={initialTab} className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 [border-bottom:var(--bd-div)] px-3 py-2">
              <TabsList variant="line">
                <TabsTrigger value="output">Output</TabsTrigger>
                <TabsTrigger value="inputs">Inputs</TabsTrigger>
                <TabsTrigger value="transcript">Steps</TabsTrigger>
                {(run.tool_calls?.length ?? 0) > 0 && (
                  <TabsTrigger value="tool-calls">Tool calls</TabsTrigger>
                )}
                {run.approval_trail && (
                  <TabsTrigger value="approval">Approval</TabsTrigger>
                )}
                <TabsTrigger value="files">Files</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
                <TabsTrigger value="raw">Raw</TabsTrigger>
                <TabsTrigger value="metadata">Metadata</TabsTrigger>
              </TabsList>
            </div>
            {/* R5 (2026-05-30): add min-w-0 + overflow-x-auto so wide content
                (markdown tables, long unbreakable strings, the Output table)
                scrolls within the column instead of overflowing and getting
                clipped by the pane's `overflow-hidden`. */}
            <TabsContent value="output" className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
              <OutputView run={run} />
            </TabsContent>
            <TabsContent value="inputs" className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
              <InputsView run={run} />
            </TabsContent>
            <TabsContent value="transcript" className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
              <TranscriptView run={run} parts={transcriptParts} />
            </TabsContent>
            <TabsContent value="tool-calls" className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
              <ToolCallsView calls={run.tool_calls ?? []} />
            </TabsContent>
            <TabsContent value="approval" className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
              <ApprovalView approval={run.approval_trail ?? null} />
            </TabsContent>
            <TabsContent value="files" className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
              <FilesView run={run} />
            </TabsContent>
            <TabsContent value="logs" className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
              <OperatorLogs run={run} />
            </TabsContent>
            <TabsContent value="raw" className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
              <RawView run={run} parts={transcriptParts} />
            </TabsContent>
            <TabsContent value="metadata" className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
              <MetadataView run={run} />
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}

// P1-3: the operator Logs view must not show sandbox-provider chatter
// ([e2b] ...), unsubstituted [redacted-*] placeholders, or per-file upload
// noise. Filter to operator-meaningful lines here; the full unfiltered
// stream stays in the Raw tab.
function OperatorLogs({ run }: { run: RunDetail }) {
  const visible = operatorLogs(run.logs);
  const hidden = run.logs.length - visible.length;
  return (
    <div className="space-y-2">
      <Terminal
        lines={visible.map((log) => ({ level: log.level, message: log.message, timestamp: log.timestamp }))}
      />
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">
          {hidden} internal log line{hidden === 1 ? "" : "s"} hidden. See the Raw tab for the full stream.
        </p>
      )}
    </div>
  );
}

function RunMetricsStrip({ run, status }: { run: RunDetail; status: string }) {
  const durationValue =
    run.duration_ms != null ? formatDuration(run.duration_ms) : status === "unknown" ? "Unknown" : "Running";
  return (
    <dl className="grid gap-px overflow-hidden rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--border-default)] text-sm sm:grid-cols-2 lg:grid-cols-5">
      <RunMetric label="Status" value={statusLabel(status)} />
      <RunMetric label="Started" value={run.started_at ? formatAbsolute(run.started_at) : "Not started"} />
      <RunMetric label="Duration" value={durationValue} />
      <RunMetric label="Output" value={`${outputItemCount(run)} item${outputItemCount(run) === 1 ? "" : "s"}`} />
      <RunMetric label="Files" value={`${run.artifacts.length} file${run.artifacts.length === 1 ? "" : "s"}`} />
    </dl>
  );
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2">
      <dt className="text-[11px] font-medium uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-foreground">{value}</dd>
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  return (
    <div className="relative flex gap-2 pb-3 pl-1">
      <div className="flex flex-col items-center">
        <RunStatusGlyph status={item.status} className="size-4" />
        <div className="mt-1 h-full w-px bg-border" />
      </div>
      <div className="min-w-0 flex-1 rounded-[var(--radius-button)] px-2 py-1 hover:bg-muted">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{item.label}</p>
          <span className="shrink-0 text-[11px] text-muted-foreground">{item.duration}</span>
        </div>
        {item.detail && <p className="truncate text-xs text-muted-foreground">{item.detail}</p>}
      </div>
    </div>
  );
}

// R9: the in-app run detail (the /runs Collection split-pane) reuses this
// exact ai-elements (Tool / Task / StackTrace) step+tool-call renderer instead
// of hand-rolling its own steps table. RunDetailSplitPane stays the single
// source of truth for transcript rendering. `RunTranscript` is the thin export
// wrapper that lets the Collection Logs tab render the same thing.
export function RunTranscript({ run }: { run: RunDetail }) {
  return <TranscriptView run={run} parts={partsFromRun(run)} />;
}

export function RunToolCalls({ run }: { run: RunDetail }) {
  return <ToolCallsView calls={run.tool_calls ?? []} />;
}

function TranscriptView({ run, parts }: { run: RunDetail; parts: RunPart[] }) {
  if (run.status === "queued") {
    const positionMsg = run.queue_position != null && run.queue_position > 0
      ? `Waiting for a free execution slot (${run.queue_position - 1} ahead)`
      : "Waiting for a free execution slot";
    return <Task title="Queued" status="pending" detail={positionMsg} />;
  }
  if (parts.length === 0) {
    return <Task title="Waiting for transcript" status={run.status === "failed" ? "failed" : "pending"} detail="No stream parts recorded yet." />;
  }

  if (!hasReadableTranscript(parts)) {
    if (run.status === "failed") {
      return (
        <div className="space-y-5">
          <StackTrace error={run.error || "Run failed"} />
          <RecentLogsPreview run={run} />
        </div>
      );
    }
    return <RunResultOverview run={run} />;
  }

  // G5 P2 (rescore2 2026-05-29): a failed run with a readable transcript but no
  // explicit "finish" part (e.g. the agent died mid-step) rendered only a red
  // "Step 1" with NO error sentence on the default Result tab — the operator
  // had to dig into Logs/Raw to learn anything. Surface the (already humanized)
  // error headline at the end of the transcript whenever the run failed and no
  // finish part carried it.
  const hasFinishPart = parts.some((p) => p.type === "finish");
  const showTrailingError = run.status === "failed" && !hasFinishPart;

  return (
    <div className="space-y-3">
      {parts.map((part, index) => {
        if (part.type === "tool-result") return null;
        if (part.type === "tool-call") {
          const result = parts.find(
            (candidate): candidate is Extract<RunPart, { type: "tool-result" }> =>
              candidate.type === "tool-result" && candidate.callId === part.callId,
          );
          return (
            <Tool
              key={`${part.callId}-${index}`}
              name={part.toolName}
              args={part.args}
              callId={part.callId}
              result={result?.result}
              isError={Boolean(result?.isError)}
            />
          );
        }
        if (part.type === "text" || part.type === "reasoning") {
          return (
            <div key={`${part.type}-${index}`} className="rounded-[var(--radius-button)] [border:var(--bd-card)] bg-muted/40 p-3">
              <p className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                {part.type === "reasoning" ? "Reasoning" : "Text"}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {stripCitationTokens(part.text)}
              </p>
            </div>
          );
        }
        if (part.type === "step-start") {
          return (
            <Task
              key={`step-${part.stepNumber}-${index}`}
              title={`Step ${part.stepNumber}`}
              status={run.status === "failed" ? "failed" : run.status === "completed" ? "completed" : "running"}
            />
          );
        }
        if (part.type === "finish") {
          if (part.status === "completed") {
            return <Task key={`finish-${index}`} title="Finished" status="completed" />;
          }
          // A HITL run parked for approval is not a failure (G5 P3) — show a
          // neutral "Awaiting approval" task, never a red StackTrace.
          if (part.status === "pending_approval") {
            return (
              <Task
                key={`finish-${index}`}
                title="Awaiting approval"
                status="pending"
                detail="This run is waiting for your decision before it continues."
              />
            );
          }
          // G5 P1 (rescore3 2026-05-29): the operator-facing failure headline
          // must be the calm backend-humanized `run.error`, NOT the raw
          // `part.error` (e.g. "Event loop is closed"). Raw stays in the Raw
          // tab. Humanize part.error only as a last-resort fallback.
          return (
            <StackTrace
              key={`finish-${index}`}
              error={run.error || humanizeRunError(part.error) || "Run failed"}
            />
          );
        }
        return null;
      })}
      {showTrailingError && (
        <StackTrace error={run.error || "This run failed. Check the logs for details."} />
      )}
    </div>
  );
}

function RunResultOverview({ run }: { run: RunDetail }) {
  return (
    <div className="space-y-6">
      <section className="rounded-[var(--radius-card)] [border:var(--bd-card)] bg-muted/20 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{run.status === "completed" ? "Run completed" : statusLabel(run.status)}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {run.worker_name || run.worker_id} produced {outputItemCount(run)} output item{outputItemCount(run) === 1 ? "" : "s"}
              {run.artifacts.length > 0 ? ` and ${run.artifacts.length} result file${run.artifacts.length === 1 ? "" : "s"}` : ""}.
            </p>
          </div>
          <a href={api.runs.downloadUrl(run.id)} download>
            <Button variant="outline" size="sm">
              <Download className="size-3.5 mr-1.5" />
              Download run
            </Button>
          </a>
        </div>
      </section>

      <OutputSummary run={run} />
      <ArtifactsList run={run} />
      <RecentLogsPreview run={run} />
    </div>
  );
}

function OutputSummary({ run }: { run: RunDetail }) {
  const allScalar = Object.entries(run.output || {}).filter(([, value]) => isScalarOutput(value));
  // P1-2: export-success booleans (pdf_export_success / docx_export_success)
  // must NOT render as bare `false`. Pull them out into a clear human state.
  const exportEntries = allScalar.filter(([key]) => isExportSuccessKey(key));
  const metricEntries = allScalar.filter(([key]) => !isExportSuccessKey(key)).slice(0, 8);
  const schemaFields = (run.output_schema || []).filter((field) => field.value != null && field.value !== "");
  const fileFields = schemaFields.filter((field) => typeof field.value === "string" && field.value.includes("/"));

  if (metricEntries.length === 0 && exportEntries.length === 0 && schemaFields.length === 0) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Output</h2>
        <p className="text-sm text-muted-foreground">No structured output was recorded.</p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Output</h2>
        <p className="text-xs text-muted-foreground">Primary result values and generated output paths.</p>
      </div>

      {metricEntries.length > 0 && (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-px overflow-hidden rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--border-default)]">
          {metricEntries.map(([key, value]) => (
            <div key={key} className="min-w-0 bg-card px-3 py-2">
              {/* P2-1: human label (no raw uppercased JSON key) */}
              <dt className="truncate text-[11px] font-medium uppercase text-muted-foreground">{humanizeKey(key)}</dt>
              <dd className="mt-0.5 truncate text-sm font-medium">{formatScalarValue(key, value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {exportEntries.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {exportEntries.map(([key, value]) => {
            const state = exportSuccessState(key, value);
            return (
              <li
                key={key}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] [border:var(--bd-pill)] px-2.5 py-0.5 text-xs font-medium",
                  state.tone === "ok"
                    ? "bg-success/10 text-success"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <span className="size-1.5 rounded-[var(--radius-pill)] bg-current opacity-70" aria-hidden="true" />
                {exportStateText(state)}
              </li>
            );
          })}
        </ul>
      )}

      {fileFields.length > 0 && (
        <div className="grid gap-2 lg:grid-cols-2">
          {fileFields.map((field) => (
            <OutputFileLink key={field.name} run={run} label={field.label || field.name} path={String(field.value)} />
          ))}
        </div>
      )}
    </section>
  );
}

function OutputFileLink({ run, label, path }: { run: RunDetail; label: string; path: string }) {
  const artifact = run.artifacts.find((candidate) => candidate.name === path);
  const href = artifact ? api.runs.artifactUrl(run.id, artifact.id) : api.runs.bundleUrl(run.id, path);
  return (
    <a
      href={href}
      download
      className="flex min-w-0 items-center justify-between gap-3 rounded-lg [border:var(--bd-card)] bg-[var(--bg-card)] px-3 py-2 text-sm hover:bg-[var(--active-nav-bg)] transition-colors"
    >
      <span className="flex min-w-0 items-center gap-2">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block truncate font-medium">{label}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">{path}</span>
        </span>
      </span>
      <Download className="size-4 shrink-0 text-muted-foreground" />
    </a>
  );
}

function ArtifactsList({ run }: { run: RunDetail }) {
  if (run.artifacts.length === 0) return null;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Result files</h2>
          <p className="text-xs text-muted-foreground">{run.artifacts.length} downloadable artifact{run.artifacts.length === 1 ? "" : "s"}.</p>
        </div>
        <a href={api.runs.downloadUrl(run.id)} download>
          <Button variant="outline" size="sm">
            <Download className="size-3.5 mr-1.5" />
            Download all
          </Button>
        </a>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        {run.artifacts.map((artifact) => (
          <a
            key={artifact.id}
            href={api.runs.artifactUrl(run.id, artifact.id)}
            download
            className="flex min-w-0 items-center justify-between gap-3 rounded-lg [border:var(--bd-card)] bg-[var(--bg-card)] px-3 py-2 text-sm hover:bg-[var(--active-nav-bg)] transition-colors"
          >
            <span className="min-w-0">
              <span className="block truncate font-mono text-xs">{artifact.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {[artifact.type || "file", artifact.size_bytes != null ? formatBytes(artifact.size_bytes) : null].filter(Boolean).join(" · ")}
              </span>
            </span>
            <Download className="size-4 shrink-0 text-muted-foreground" />
          </a>
        ))}
      </div>
    </section>
  );
}

function RecentLogsPreview({ run }: { run: RunDetail }) {
  // P1-3: the Result-tab log preview is operator-facing too — filter the same
  // infra/[redacted] noise the Logs tab hides.
  const recent = operatorLogs(run.logs).slice(-8);
  if (recent.length === 0) return null;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Recent logs</h2>
        <p className="text-xs text-muted-foreground">Last {recent.length} server-side log entr{recent.length === 1 ? "y" : "ies"}.</p>
      </div>
      <div className="overflow-hidden rounded-[var(--radius-card)] [border:var(--bd-card)]">
        {recent.map((log, index) => (
          <div key={`${log.timestamp}-${index}`} className="grid gap-2 [border-bottom:var(--bd-div)] bg-[var(--bg-card)] px-3 py-2 text-xs last:[border-bottom:0] sm:grid-cols-[8.5rem_5rem_1fr]">
            <span className="font-mono text-muted-foreground">{formatTime(log.timestamp)}</span>
            <span className={cn("font-medium uppercase", log.level === "error" || log.level === "critical" ? "text-error" : "text-muted-foreground")}>
              {log.level}
            </span>
            {/* G5 rescore4 P2: humanize error/critical log lines in the
                Result-tab preview so raw strings ("ERROR Agent runtime error:
                Event loop is closed") don't leak. Full raw stays in Raw tab. */}
            <span className="min-w-0 break-words text-foreground">
              {humanizeLogMessage(log.level, log.message)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// v6 default tab: render the OUTPUT inline through the GENERIC renderer
// (markdown/json/csv/text/file), with NO use-case chrome. Falls back to the
// readable transcript when a completed run produced no structured output so the
// output-first tab is never empty.
function OutputView({ run }: { run: RunDetail }) {
  const hasSchema = run.output_schema && run.output_schema.length > 0;
  const hasRaw = Object.keys(run.output || {}).length > 0;
  if (run.status === "failed") {
    return <StackTrace error={run.error} />;
  }
  if (hasSchema) {
    return (
      <div className="space-y-6">
        {run.output_schema.map((field) => (
          <OutputRenderer key={field.name} field={field} runId={run.id} />
        ))}
      </div>
    );
  }
  if (hasRaw) {
    return (
      <div className="space-y-4">
        {Object.entries(run.output).map(([key, value]) => (
          <div key={key} className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{humanizeKey(key)}</p>
            <GenericOutput type={inferOutputType(value)} value={value} />
          </div>
        ))}
      </div>
    );
  }
  // No structured output. For a completed run, show the readable transcript so
  // the output-first tab carries the result; otherwise an empty-state.
  if (run.status === "completed" || run.status === "running" || run.status === "queued") {
    return <TranscriptView run={run} parts={partsFromRun(run)} />;
  }
  return <p className="text-sm text-muted-foreground">No output yet.</p>;
}

// Infer a GenericOutput type from a raw output value (no schema available).
function inferOutputType(value: unknown): string {
  if (typeof value === "object" && value !== null) return "json";
  if (typeof value === "string") {
    const t = value.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) return "json";
    if (/^#{1,3}\s|\n[-*]\s|\|.+\|/.test(t)) return "markdown";
    return "text";
  }
  return "text";
}

// v6: dedicated Files tab so result artifacts are a secondary surface, not a
// third vertical block stacked under the output.
function FilesView({ run }: { run: RunDetail }) {
  if (run.artifacts.length === 0) {
    return <p className="text-sm text-muted-foreground">No result files.</p>;
  }
  return <ArtifactsList run={run} />;
}

function RawView({ run, parts }: { run: RunDetail; parts: RunPart[] }) {
  // S29k (Q3 Codex verdict): canonical full-fidelity surface for debugging.
  // SSE parts (no timestamps; stream order is time order) + server-side
  // logs (timestamped) joined into one document. JSON download button
  // exports everything so users can diff offline or share with support.
  const payload = {
    run_id: run.id,
    worker_id: run.worker_id,
    status: run.status,
    error: run.error,
    started_at: run.started_at,
    completed_at: run.completed_at,
    duration_ms: run.duration_ms,
    input: run.input,
    output: run.output,
    artifacts: run.artifacts,
    parts,
    logs: run.logs,
  };
  const json = JSON.stringify(payload, null, 2);
  const download = () => {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${run.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Raw run data</p>
          <p className="text-xs text-muted-foreground">
            Full SSE part stream, logs, inputs, outputs, and artifacts. Use this when transcript/output don&apos;t show enough.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? <Check className="size-3.5 mr-1.5" /> : <Copy className="size-3.5 mr-1.5" />}
            {copied ? "Copied" : "Copy JSON"}
          </Button>
          <Button variant="outline" size="sm" onClick={download}>
            <Download className="size-3.5 mr-1.5" />
            Download
          </Button>
        </div>
      </div>

      <section className="space-y-2">
        <p className="text-[11px] font-medium text-muted-foreground">Parts (SSE stream order)</p>
        {parts.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No parts captured.</p>
        ) : (
          <pre className="rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-2)] dark:bg-[#1a1a1a] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words overflow-auto max-h-[400px]">
            {parts.map((p, i) => `[${i.toString().padStart(3, "0")}] ${p.type}\n${JSON.stringify(p, null, 2)}`).join("\n\n")}
          </pre>
        )}
      </section>

      <section className="space-y-2">
        <p className="text-[11px] font-medium text-muted-foreground">Logs (server-side, timestamped)</p>
        {run.logs.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No logs captured.</p>
        ) : (
          <pre className="rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-2)] dark:bg-[#1a1a1a] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words overflow-auto max-h-[400px]">
            {run.logs.map((l) => `${l.timestamp} [${l.level.toUpperCase()}]${l.trace_id ? ` ${l.trace_id}` : ""} ${l.message}`).join("\n")}
          </pre>
        )}
      </section>
    </div>
  );
}

function InputsView({ run }: { run: RunDetail }) {
  const entries = Object.entries(run.input || {});
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No inputs were provided for this run.</p>;
  }
  return (
    <div className="space-y-3">
      {entries.map(([key, value]) => (
        <div key={key} className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{key}</p>
          {typeof value === "string" ? (
            <p className="text-sm text-foreground whitespace-pre-wrap break-words rounded-[var(--radius-button)] [border:var(--bd-card)] bg-muted/30 px-3 py-2">
              {value || <span className="italic text-muted-foreground">empty</span>}
            </p>
          ) : (
            <pre className="text-xs text-foreground whitespace-pre-wrap break-words rounded-[var(--radius-button)] [border:var(--bd-card)] bg-muted/30 px-3 py-2">
              {JSON.stringify(value, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function ToolCallsView({ calls }: { calls: ToolCallEntry[] }) {
  if (calls.length === 0) {
    return <p className="text-sm text-muted-foreground">No tool calls recorded for this run.</p>;
  }
  return (
    <div className="space-y-3">
      {calls.map((call) => (
        <div key={call.id} className="rounded-[var(--radius-button)] [border:var(--bd-card)] overflow-hidden">
          <div className="flex items-center gap-2 bg-muted/40 px-3 py-2 [border-bottom:var(--bd-div)]">
            <span className="font-mono text-xs font-medium text-foreground">{call.name}</span>
            {call.error && (
              <span className="ml-auto text-xs text-destructive">error</span>
            )}
          </div>
          <div className="grid grid-cols-2 [&>*+*]:[border-left:var(--bd-div)]">
            <div className="p-3">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Arguments</p>
              <pre className="text-xs text-foreground whitespace-pre-wrap break-words leading-5">
                {JSON.stringify(call.arguments, null, 2)}
              </pre>
            </div>
            <div className="p-3">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {call.error ? "Error" : "Result"}
              </p>
              <pre className="text-xs text-foreground whitespace-pre-wrap break-words leading-5">
                {call.error
                  ? call.error
                  : typeof call.result === "string"
                  ? call.result
                  : JSON.stringify(call.result, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ApprovalView({ approval }: { approval: ApprovalEntry | null }) {
  if (!approval) {
    return <p className="text-sm text-muted-foreground">No approval required for this run.</p>;
  }
  const statusColor =
    approval.status === "approved"
      ? "text-emerald-600"
      : approval.status === "rejected"
      ? "text-destructive"
      : "text-[var(--ink-soft)]";
  return (
    <div className="space-y-4 max-w-lg">
      <div className="rounded-[var(--radius-button)] [border:var(--bd-card)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{approval.label || "Approval checkpoint"}</span>
          <span className={cn("text-xs font-medium capitalize", statusColor)}>{approval.status}</span>
        </div>
        {approval.preview && (
          <pre className="text-xs text-foreground whitespace-pre-wrap break-words rounded [border:var(--bd-card)] bg-muted/30 px-3 py-2">
            {approval.preview}
          </pre>
        )}
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div>
            <span className="font-medium">Requested</span>
            <p>{formatAbsolute(approval.created_at)}</p>
          </div>
          {approval.decided_at && (
            <div>
              <span className="font-medium">Decided</span>
              <p>{formatAbsolute(approval.decided_at)}</p>
            </div>
          )}
        </div>
        {approval.reason && (
          <p className="text-xs text-muted-foreground [border-top:var(--bd-div)] pt-2">
            <span className="font-medium">Reason: </span>{approval.reason}
          </p>
        )}
        {approval.follow_up_run_id && (
          <p className="text-xs">
            <span className="text-muted-foreground">Follow-up run: </span>
            <Link href={`/runs/${approval.follow_up_run_id}`} className="text-primary hover:underline font-mono">
              {approval.follow_up_run_id}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

function MetadataView({ run }: { run: RunDetail }) {
  const metadata = {
    id: run.id,
    worker_id: run.worker_id,
    trigger_source: run.trigger_source,
    runner: run.runner,
    status: run.status,
    created_at: run.created_at,
    started_at: run.started_at,
    completed_at: run.completed_at,
    duration_ms: run.duration_ms,
    input: run.input,
    artifacts: run.artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      size_bytes: artifact.size_bytes,
    })),
  };
  return (
    <pre className="max-h-[620px] overflow-auto rounded-[var(--radius-button)] bg-muted p-3 font-mono text-xs leading-relaxed">
      {JSON.stringify(metadata, null, 2)}
    </pre>
  );
}

type TimelineItem = {
  label: string;
  detail?: string;
  duration: string;
  status: string;
};

function buildTimeline(run: RunDetail, parts: RunPart[]): TimelineItem[] {
  const rows: TimelineItem[] = [];
  for (const part of parts) {
    if (part.type === "step-start") {
      rows.push({ label: `Step ${part.stepNumber}`, duration: "start", status: run.status });
    } else if (part.type === "tool-call") {
      rows.push({ label: part.toolName, detail: part.callId, duration: "tool", status: run.status });
    } else if (part.type === "text") {
      rows.push({ label: "Assistant text", detail: clip(part.text), duration: "stream", status: run.status });
    } else if (part.type === "reasoning") {
      rows.push({ label: "Reasoning", detail: clip(part.text), duration: "stream", status: run.status });
    } else if (part.type === "finish") {
      // G5 P3: a "pending_approval" finish is a parked state, not a failure —
      // it must not render a red "Failed" row in the timeline (caught on the
      // live run-detail timeline after the first P3 pass).
      const isCompleted = part.status === "completed";
      const isPending = part.status === "pending_approval";
      // G5 P1 (rescore3 2026-05-29): the timeline subtitle is an operator
      // surface 6px from the calm Error banner — it must show the SAME
      // humanized headline (`run.error`), never the raw `part.error`
      // ("Event loop is closed"). Raw stays in the Raw tab.
      const failureDetail = run.error || humanizeRunError(part.error) || undefined;
      rows.push({
        label: isCompleted ? "Completed" : isPending ? "Awaiting approval" : "Failed",
        detail: isPending ? "Waiting for your decision" : isCompleted ? undefined : failureDetail,
        duration: run.duration_ms != null ? formatDuration(run.duration_ms) : "done",
        status: isCompleted ? "completed" : isPending ? "pending_approval" : "failed",
      });
    }
  }
  if (rows.length === 0) {
    return logsToTimeline(run.logs, run.status);
  }
  return rows;
}

function logsToTimeline(logs: LogEntry[], status: string): TimelineItem[] {
  if (logs.length === 0) return [{ label: "Queued", duration: "waiting", status }];
  return logs.map((log, index) => ({
    label: log.message,
    duration: index === 0 ? "start" : deltaLabel(logs[index - 1]?.timestamp, log.timestamp),
    status: log.level === "error" ? "failed" : status,
  }));
}

function latestStatus(run: RunDetail, parts: RunPart[]): string {
  // The persisted run.status is authoritative once the run reaches a terminal
  // state. A HITL run that was approved and finished has run.status
  // "completed", but its transcript can still end on a stale "pending_approval"
  // finish part (no fresh completed finish is appended on resume). Trusting the
  // part there made the header badge read "Awaiting approval" while the STATUS
  // tile and Result overview correctly read "completed". Prefer run.status when
  // it is already terminal so all three surfaces agree.
  if (run.status === "completed" || run.status === "failed") return run.status;
  const finish = [...parts].reverse().find((part) => part.type === "finish");
  if (finish?.type === "finish") {
    // G5 P3 (rescore2 2026-05-29): a HITL run that parks for approval emits a
    // finish part with status "pending_approval". Treating any non-"completed"
    // finish as "failed" rendered a brand-new awaiting-approval run as a red
    // "Failed". Preserve the real terminal/parked status; only true failures
    // are failures.
    if (finish.status === "completed") return "completed";
    if (finish.status === "pending_approval") return "pending_approval";
    return "failed";
  }
  return run.status;
}

function hasReadableTranscript(parts: RunPart[]): boolean {
  return parts.some((part) => part.type === "text" || part.type === "reasoning" || part.type === "tool-call" || part.type === "step-start");
}

function partsFromRun(run: RunDetail): RunPart[] {
  const parts = transcriptRowsToParts(run.transcript || []);
  if (run.status === "completed") parts.push({ type: "finish", status: "completed" });
  if (run.status === "failed") parts.push({ type: "finish", status: "failed", error: run.error });
  return parts;
}

function transcriptRowsToParts(rows: TranscriptRow[]): RunPart[] {
  const parts: RunPart[] = [];
  rows.forEach((row, index) => {
    if (row.role === "assistant" && typeof row.content === "string" && row.content) {
      parts.push({ type: "text", text: row.content });
    }
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    for (const call of toolCalls) {
      const callRecord = call as { id?: string; function?: { name?: string; arguments?: string } };
      const callId = callRecord.id || `transcript_call_${index}`;
      parts.push({
        type: "tool-call",
        toolName: callRecord.function?.name || "tool",
        args: parseMaybeJson(callRecord.function?.arguments),
        callId,
      });
    }
    if (row.role === "tool") {
      parts.push({
        type: "tool-result",
        callId: row.tool_call_id || `transcript_result_${index}`,
        result: parseMaybeJson(typeof row.content === "string" ? row.content : row.content),
        isError: false,
      });
    }
    if (row.type === "tool_call") {
      parts.push({
        type: "tool-call",
        toolName: row.name || "tool",
        args: row.arguments ?? {},
        callId: row.tool_call_id || `transcript_call_${index}`,
      });
    }
    if (row.type === "tool_result") {
      parts.push({
        type: "tool-result",
        callId: row.tool_call_id || `transcript_result_${index}`,
        result: row.content,
        isError: false,
      });
    }
  });
  return parts;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isScalarOutput(value: unknown): value is string | number | boolean {
  return typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && !value.includes("/") && value.length <= 120);
}

function outputItemCount(run: RunDetail): number {
  return run.output_schema?.length || Object.keys(run.output || {}).length;
}

// P2-1: render scalar values readably. Booleans become Yes/No; "*_seconds"
// durations become a compact duration; everything else is stringified.
function formatScalarValue(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && /_seconds$/i.test(key)) {
    const ms = value * 1000;
    return formatDuration(Math.round(ms));
  }
  return String(value);
}

// v6: statuses render in Title Case across the run page (header glyph, metrics
// strip, overview). "pending_approval" -> "Awaiting approval"; everything else
// is humanized then title-cased ("completed" -> "Completed").
function statusLabel(value: string): string {
  const s = (value || "").toLowerCase();
  if (s === "pending_approval") return "Awaiting approval";
  const words = s.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function clip(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function deltaLabel(previous?: string, current?: string): string {
  if (!previous || !current) return "";
  const delta = new Date(current).getTime() - new Date(previous).getTime();
  if (!Number.isFinite(delta) || delta < 0) return "";
  return formatDuration(delta);
}
