"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import Papa from "papaparse";
import { ChevronDown, Download } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusPill } from "@/components/collection/StatusPill";
import { api } from "@/lib/api";
import { useRuns } from "@/lib/query/hooks";
import { formatRelative } from "@/lib/formatters";
import { humanizeKey } from "@/lib/run-format";
import type { RunSummary, RunDetail, WorkerSummary } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { LoadingState } from "@/components/collection/CollectionStates";
import { InlineFileOpen, type InlineFile } from "@/components/file-viewer/InlineFileOpen";
import { OutputRenderer } from "@/components/output-renderer";
import { GenericOutput } from "@/components/generic-output";
import { RunTranscript } from "@/components/RunDetailSplitPane";
import { RUN_DETAIL_TABS, type RunDetailTab } from "@/lib/runs/tabs";
import { useRunLogStream } from "@/lib/useRunLogStream";
import { contentTagOptions } from "@/lib/workers/derive";
import {
  formatDuration,
  formatTrigger,
  triggerKey,
  runStatusPill,
  runSortTime,
  runsToCsvRows,
  inferOutputType,
} from "@/lib/runs/format";

const detailCache = new Map<string, RunDetail>();

// gap N2: a run can be cancelled only while it is in-progress (running or
// queued). Terminal runs (completed / failed / cancelled) expose no Cancel.
// Single source of truth shared by the detail header and the row menu so the
// two surfaces can never disagree.
export function isCancellableRunStatus(status?: string): boolean {
  return status === "running" || status === "queued";
}

function useRunDetail(id: string, status?: string): RunDetail | undefined {
  const [d, setD] = useState<RunDetail | undefined>(detailCache.get(id));
  // §2.1: never serve a cached entry for an active (running/queued) run so the
  // detail re-fetches when the run completes and the OutputTab shows final output.
  const isActive = status === "running" || status === "queued";
  useEffect(() => {
    if (!isActive && detailCache.has(id)) {
      setD(detailCache.get(id));
      return;
    }
    let alive = true;
    api.runs
      .get(id)
      .then((rd) => {
        if (!isActive) detailCache.set(id, rd);
        if (alive) setD(rd);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, isActive]);
  return d;
}

// Humane RESULT render (rule #2): reuse the shared OutputRenderer/GenericOutput
// (the same primitives the run page uses) so the result reads as markdown / text
// / table / formatted values — NOT a raw JSON.stringify wall. A declared
// output_schema renders per field; otherwise each output key is rendered by its
// inferred type. A Preview/Raw toggle (rule #1 — same content, two view modes,
// NOT a separate tab) flips this humane view to the raw JSON source in place.
function ResultPreview({ d }: { d: RunDetail }) {
  const output = d.output ?? {};
  const hasSchema = (d.output_schema?.length ?? 0) > 0;
  const keys = Object.keys(output);
  if (!hasSchema && keys.length === 0) {
    return <div style={muted}>Run completed with no structured output.</div>;
  }
  if (hasSchema) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {d.output_schema.map((field) => (
          <OutputRenderer key={field.name} field={field} runId={d.id} />
        ))}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {keys.map((key) => (
        <div key={key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p style={{ ...kvK, fontWeight: 500 }}>{humanizeKey(key)}</p>
          <GenericOutput type={inferOutputType(output[key])} value={output[key]} />
        </div>
      ))}
    </div>
  );
}

// R9: quiet one-line metrics strip for the output-first in-app run detail.
// A thin inline row of muted key/value pairs (started · duration · tokens ·
// files), NOT a card grid and NOT a left sidebar; the result leads, this is
// context underneath the header.
function RunMetricsStrip({ d }: { d: RunDetail }) {
  const tokenCount = resolveTokenCount(d);
  const items: Array<[string, string]> = [
    ["Started", d.started_at ? formatRelative(d.started_at) : "Not started"],
    ["Duration", formatDuration(d.duration_ms)],
    ["Files", String(d.artifacts?.length ?? 0)],
  ];
  if (tokenCount != null) items.push(["Tokens", tokenCount.toLocaleString()]);
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 18px",
        fontSize: 12.5,
        color: "var(--muted-foreground)",
      }}
    >
      {items.map(([label, value]) => (
        <span key={label}>
          {label}
          {": "}
          <span style={{ color: "var(--ink-soft)", fontWeight: 500 }}>{value}</span>
        </span>
      ))}
    </div>
  );
}

// SPEC §4 Output: files FIRST (§2.6), then the humane result with a Preview/Raw
// toggle. Files open INLINE (breadcrumb/Back/Download); a SINGLE file auto-opens
// (rule #3 — no folder-then-file clicking), and every file carries the same
// Preview/Raw toggle (#1289) for code/markdown/text. PNG artifacts render as
// images (shared InlineFileOpen, rule #5).
function OutputTab({ r }: { r: RunSummary }) {
  const d = useRunDetail(r.id, r.status);
  // rule #1: Preview (humane) vs Raw (JSON source) on the SAME result.
  const [resultMode, setResultMode] = useState<"preview" | "raw">("preview");
  if (!d) return <LoadingState rows={4} />;
  const files: InlineFile[] = (d.artifacts ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    url: api.runs.artifactUrl(d.id, a.id),
    sizeBytes: a.size_bytes,
  }));
  // rule #3: one file → auto-open it inline; multiple → list with the first
  // selectable but the content still one click away (no folder depth).
  const autoOpenId = files.length === 1 ? files[0].id : undefined;
  // Run artifacts are same-origin proxy URLs (auth injected server-side), so the
  // Preview/Raw toggle can read text content directly from the download URL.
  const loadArtifactText = async (file: InlineFile): Promise<string> => {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`Could not read ${file.name}`);
    return res.text();
  };
  // .npz array viewer: same same-origin proxy URL, fetched as raw bytes and
  // parsed header-only client-side (no numpy, no array-data load).
  const loadArtifactBlob = async (file: InlineFile): Promise<ArrayBuffer> => {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`Could not read ${file.name}`);
    return res.arrayBuffer();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* R9: output-first. A quiet, thin inline metrics row (NOT a card grid,
          NOT a left sidebar) carries the run's context; the result owns the
          full width below. Duration / started / tokens moved here out of the
          header so the header matches the worker-detail treatment. */}
      <RunMetricsStrip d={d} />
      {d.error && (
        <div className="c-pill err" style={{ alignSelf: "flex-start" }}>
          <span className="dot" />
          {d.error}
        </div>
      )}
      {/* §2.6: files shown FIRST, before the result */}
      {files.length > 0 && (
        <div>
          <h4 style={h4}>{files.length === 1 ? "File" : "Files"}</h4>
          <InlineFileOpen
            files={files}
            rootLabel="Output"
            defaultOpenId={autoOpenId}
            loadText={loadArtifactText}
            loadBlob={loadArtifactBlob}
          />
        </div>
      )}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }}>
          <h4 style={{ ...h4, margin: 0 }}>Result</h4>
          {/* rule #1: same result, Preview/Raw toggle in place — not a Raw tab. */}
          <div className="c-vtog" role="group" aria-label="Result view mode" style={{ marginLeft: "auto" }}>
            <button
              type="button"
              className={resultMode === "preview" ? "on" : ""}
              aria-pressed={resultMode === "preview"}
              onClick={() => setResultMode("preview")}
            >
              Preview
            </button>
            <button
              type="button"
              className={resultMode === "raw" ? "on" : ""}
              aria-pressed={resultMode === "raw"}
              onClick={() => setResultMode("raw")}
            >
              Raw
            </button>
          </div>
        </div>
        {resultMode === "preview" ? (
          <ResultPreview d={d} />
        ) : (
          <pre style={code}>{JSON.stringify(d.output ?? {}, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

// SPEC §4 Logs (rule #4 — renamed from "Trace"): steps + log lines. Transcript
// carries no per-step timestamps (no structured field), so durations come from
// the run-level timeline, not faked.

/** #1275: read token count from every location the backend might put it. */
function resolveTokenCount(d: import("@/lib/types").RunDetail): number | null {
  if (d.total_tokens != null) return d.total_tokens;
  // Some workers surface usage in the output object under common key names.
  const out = d.output ?? {};
  for (const key of ["total_tokens", "tokens", "token_count"]) {
    const v = out[key];
    if (typeof v === "number") return v;
  }
  // Nested usage object (e.g. { usage: { total_tokens: N } })
  const usage = out["usage"];
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const u = usage as Record<string, unknown>;
    const t = u["total_tokens"] ?? u["tokens"];
    if (typeof t === "number") return t;
    const i = typeof u["input_tokens"] === "number" ? (u["input_tokens"] as number) : 0;
    const o = typeof u["output_tokens"] === "number" ? (u["output_tokens"] as number) : 0;
    if (i + o > 0) return i + o;
  }
  return null;
}

// §2.4/§2.5: Stream logs in real-time via GET /runs/{id}/logs/stream (SSE).
// §2.1: While the run is in-progress, show the live stream instead of static data.
// The hook replays full history on connect, so no separate REST fetch is needed
// for logs. We still load the run detail (useRunDetail) for steps, tokens, and
// raw JSON -- those are not in the log stream.
function LogsTab({ r }: { r: RunSummary }) {
  const d = useRunDetail(r.id, r.status);
  // Live SSE log stream -- connects immediately and accumulates log lines.
  const { logs: streamLogs, connected: logConnected, done: logDone } = useRunLogStream(r.id);

  if (!d) return <LoadingState rows={4} />;
  // Prefer the live stream logs while the run is active or the stream is
  // open; fall back to the static d.logs once the stream is done and the
  // detail payload has fully loaded (completed/failed runs).
  const isActive = r.status === "running" || r.status === "queued";
  const logs = isActive || logConnected || (streamLogs.length > 0 && !logDone)
    ? streamLogs
    : (d.logs ?? []);
  const tokenCount = resolveTokenCount(d);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={kv}>
        <span style={kvK}>Duration</span>
        <span>{formatDuration(d.duration_ms)}</span>
        <span style={kvK}>Tokens</span>
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {tokenCount != null ? tokenCount.toLocaleString() : "—" /* em-dash-ok: blank-value glyph */}
        </span>
      </div>
      <div>
        <h4 style={h4}>Steps</h4>
        {/* R9: reuse RunDetailSplitPane's real ai-elements (Tool / Task /
            StackTrace) transcript renderer, no hand-rolled steps table. The
            tool-call blocks, step tasks, and failure banners are the same
            components used everywhere else a run is rendered. */}
        <RunTranscript run={d} />
      </div>
      <div>
        <h4 style={h4}>
          Logs
          {/* Live indicator while stream is open and run is active */}
          {logConnected && isActive && (
            <span style={{ marginLeft: 8, color: "var(--accent, #3E6FE0)", fontWeight: 500, fontSize: 10 }}>
              Live
            </span>
          )}
        </h4>
        {logs.length > 0 ? (
          <pre style={code}>
            {logs
              .map((l) => {
                const ts = l.timestamp ? l.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z") : "";
                const tid = l.trace_id ? ` [${l.trace_id.slice(0, 8)}]` : "";
                return `${ts} [${l.level}]${tid} ${l.message}`;
              })
              .join("\n")}
          </pre>
        ) : isActive && logConnected ? (
          <div style={{ ...muted, padding: 14 }}>Waiting for log output...</div>
        ) : (
          <div style={{ ...muted, padding: 14 }}>No logs recorded.</div>
        )}
      </div>
      <details>
        <summary className="c-vpill inline-flex cursor-pointer" style={{ padding: "6px 11px", fontSize: 12.5 }}>
          View raw JSON
        </summary>
        <pre style={{ ...code, marginTop: 10 }}>{JSON.stringify(d, null, 2)}</pre>
      </details>
    </div>
  );
}

// SPEC §4: Inputs — the run's input payload.
function InputsTab({ r }: { r: RunSummary }) {
  const d = useRunDetail(r.id, r.status);
  if (!d) return <LoadingState rows={3} />;
  const input = d.input ?? {};
  if (Object.keys(input).length === 0) return <div style={muted}>This run took no inputs.</div>;
  return <pre style={code}>{JSON.stringify(input, null, 2)}</pre>;
}

// Tab key → its (named) component, keyed by RUN_DETAIL_TABS so the §4 contract
// test guards the live tab set.
const RUN_TAB_COMPONENT: Record<RunDetailTab, (props: { r: RunSummary }) => React.ReactNode> = {
  Output: OutputTab,
  Logs: LogsTab,
  Inputs: InputsTab,
};

const PAGE_SIZE = 50;

export default function RunsCollection({ initialRuns }: { initialRuns: RunSummary[] }) {
  // Cache-first first page (TanStack Query): /runs renders instantly from cache
  // on return; a slow or failed refetch keeps the cached rows instead of going
  // blank or flashing an error. Pagination (loadMore) and the bell refresh stay local.
  const runsQuery = useRuns(
    { limit: PAGE_SIZE, offset: 0 },
    initialRuns.length > 0 ? initialRuns : undefined,
  );
  const [runs, setRuns] = useState<RunSummary[]>(initialRuns);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(initialRuns.length === 0); // unknown until first fetch
  const [offset, setOffset] = useState(0);
  const [now] = useState(() => Date.now());

  // Sync the cached first page into local state (which loadMore appends to).
  useEffect(() => {
    if (runsQuery.data) {
      const sorted = [...runsQuery.data].sort((a, b) => runSortTime(b) - runSortTime(a));
      setRuns(sorted);
      setOffset(PAGE_SIZE);
      setHasMore(runsQuery.data.length === PAGE_SIZE);
    }
  }, [runsQuery.data]);

  // Skeleton only on a true cold start (no cache and no server data).
  const loading = runsQuery.isLoading && runs.length === 0;

  // Append the next page of runs (B37 — "Load more" pattern).
  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const rows = await api.runs.list({ limit: PAGE_SIZE, offset });
      const sorted = [...rows].sort((a, b) => runSortTime(b) - runSortTime(a));
      setRuns((prev) => {
        // Deduplicate by id in case a new run appeared between pages.
        const seen = new Set(prev.map((r) => r.id));
        const novel = sorted.filter((r) => !seen.has(r.id));
        return [...prev, ...novel].sort((a, b) => runSortTime(b) - runSortTime(a));
      });
      setOffset((o) => o + PAGE_SIZE);
      setHasMore(rows.length === PAGE_SIZE);
    } catch {
      // leave existing rows intact
    } finally {
      setLoadingMore(false);
    }
  };

  const refresh = async (initial = false) => {
    if (initial) {
      await runsQuery.refetch();
    } else {
      // Non-initial refresh re-fetches the current window size (keeps existing offset).
      try {
        const rows = await api.runs.list({ limit: Math.max(offset, PAGE_SIZE) });
        setRuns([...rows].sort((a, b) => runSortTime(b) - runSortTime(a)));
      } catch {
        // leave existing state intact on refresh errors
      }
    }
  };

  useEffect(() => {
    // Runs first page comes from the cache-first query above; here we only need
    // the workers list for content-tag filtering (SPEC §11).
    api.workers.list().then(setWorkers).catch(() => {});
  }, []);

  // worker_id → its content tags, for tag filtering + the shared vocabulary.
  const workerTags = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const w of workers) m[w.id] = w.tags ?? [];
    return m;
  }, [workers]);

  const sorted = useMemo(
    () => [...runs].sort((a, b) => runSortTime(b) - runSortTime(a)),
    [runs],
  );

  // Export CSV — fetch all pages (not just the loaded window), then download.
  const exportCSV = async () => {
    const PAGE = 500;
    let all: RunSummary[] = [];
    try {
      for (let offset = 0; ; offset += PAGE) {
        const page = await api.runs.list({ limit: PAGE, offset });
        all = [...all, ...page];
        if (page.length < PAGE) break;
      }
    } catch {
      all = runs;
    }
    const csv = Papa.unparse(runsToCsvRows(all));
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `workeros-runs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${all.length} runs`);
  };

  // #796: bulk-export the loaded runs as one ZIP (result + artifacts per run).
  const [exportingZip, setExportingZip] = useState(false);
  const exportZip = async () => {
    const ids = runs.map((r) => r.id);
    if (ids.length === 0) {
      toast("No runs to export.");
      return;
    }
    setExportingZip(true);
    try {
      const blob = await api.runs.exportBundle(ids);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `workeros-runs-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${ids.length} runs`);
    } catch (err) {
      toast.error((err as Error).message || "Could not export runs.");
    } finally {
      setExportingZip(false);
    }
  };

  const replay = async (r: RunSummary) => {
    try {
      const res = await api.runs.replay(r.worker_id, r.id);
      toast.success(res.run_id ? `Replaying · #${res.run_id}` : "Replay started");
      await refresh();
    } catch {
      toast.error("Could not replay this run.");
    }
  };

  // gap N2: cancel an in-progress run via the real POST /runs/{id}/cancel
  // endpoint (api.runs.cancel — previously invoked by zero components). Confirm
  // first (irreversible), then refresh so the row/detail reflect the new status.
  const cancel = async (r: RunSummary) => {
    if (!isCancellableRunStatus(r.status)) return;
    if (!window.confirm("Cancel this run? It cannot be resumed.")) return;
    try {
      await api.runs.cancel(r.id);
      toast.success("Cancellation requested");
      await refresh();
    } catch (err) {
      toast.error((err as Error).message || "Could not cancel this run.");
    }
  };

  const config: CollectionConfig<RunSummary> = {
    title: "Run history",
    items: sorted,
    loading,
    idOf: (r) => r.id,
    view: { default: "list", grid: true },
    searchOf: (r) => `${r.worker_name ?? r.worker_id} ${r.id} ${r.trigger_source}`,
    tagsOf: (r) =>
      ({
        smart: now - runSortTime(r) <= 14 * 86400000 ? ["recent"] : [],
        status: [r.status],
        trigger: [triggerKey(r.trigger_source)],
        content: workerTags[r.worker_id] ?? [],
      }) as Partial<Record<TagFamilyKey, string[]>>,
    tags: {
      smart: [{ value: "recent", label: "Recent" }],
      status: [
        { value: "running", label: "running" },
        { value: "queued", label: "queued" },
        { value: "completed", label: "completed" },
        { value: "failed", label: "failed" },
      ],
      trigger: [
        { value: "scheduled", label: "scheduled" },
        { value: "manual", label: "manual" },
        { value: "webhook", label: "webhook" },
      ],
      content: contentTagOptions(workers),
    },
    counts: [
      { value: sorted.length, label: "runs" },
      { value: sorted.filter((r) => r.status === "failed").length, label: "failed" },
      { value: sorted.filter((r) => r.status === "running").length, label: "running" },
    ],
    toolbarActions: (
      <DropdownMenu>
        <DropdownMenuTrigger className="c-vpill" style={{ padding: "9px 12px", gap: 5 }}>
          <Download size={14} /> Export <ChevronDown size={12} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40 p-1">
          <DropdownMenuItem
            onClick={() => void exportCSV()}
            className="flex items-center gap-2 text-sm text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
          >
            <Download size={14} /> Export CSV
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={exportingZip}
            onClick={() => void exportZip()}
            className="flex items-center gap-2 text-sm text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
          >
            <Download size={14} /> {exportingZip ? "Exporting…" : "Export ZIP"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
    columns: {
      template: "1.6fr 1fr .8fr 130px 1fr",
      headers: ["Worker", "Trigger", "Duration", "Status", "Started"],
      statusColumn: false,
      // gap N2: re-enable the trailing ⋯ row-action slot so in-progress runs can
      // be cancelled directly from the list. Terminal runs render no menu.
      menuColumn: true,
    },
    row: (r) => ({
      // V4 SPEC rule 3: no avatar for runs — non-person entity.
      primary: r.worker_name ?? r.worker_id,
      // secondary shows status + relative time in compact (split-left) mode where
      // c-cell children are hidden (#1132).
      secondary: `${runStatusPill(r.status).label} · ${formatRelative(r.created_at ?? r.started_at ?? "")}`,
      cols: [
        formatTrigger(r.trigger_source),
        formatDuration(r.duration_ms),
        <StatusPill key="status" spec={runStatusPill(r.status)} />,
        formatRelative(r.created_at ?? r.started_at ?? ""),
      ],
      // gap N2: Cancel row action, only for in-progress runs. Omitting `menu`
      // entirely for terminal runs hides the ⋯ menu for that row.
      menu: isCancellableRunStatus(r.status)
        ? [{ label: "Cancel run", danger: true, onSelect: () => void cancel(r) }]
        : undefined,
    }),
    card: (r) => ({
      // V4 SPEC rule 3: no avatar monogram for runs.
      name: r.worker_name ?? r.worker_id,
      description: `${formatTrigger(r.trigger_source)} · ${formatDuration(r.duration_ms)}`,
      status: runStatusPill(r.status),
    }),
    detail: (r) => ({
      header: {
        // V4 SPEC rule 3: no avatar in detail header for runs.
        leading: undefined,
        title: (
          <span title={`Run · ${r.worker_name ?? r.worker_id}`}>
            {`Run · ${r.worker_name ?? r.worker_id}`}
          </span>
        ),
        // R9: header matches the WORKER detail treatment exactly — a status
        // c-pill plus a quiet description line, NOT a verbose
        // "trigger · duration · started" string above the tabs (Federico:
        // "too much info above the tabs, inconsistent"). Duration / started /
        // tokens now live as a quiet metrics strip INSIDE the Output body
        // (output-first), not in the header.
        sub: (
          <>
            <StatusPill spec={runStatusPill(r.status)} />
            <span className="c-dh-desc">{formatTrigger(r.trigger_source)}</span>
          </>
        ),
        actions: (
          <>
            {/* SPEC §4: ↑ worker link (worker_id on every run — BUILT). */}
            <Link href={`/workers?sel=${encodeURIComponent(r.worker_id)}`} className="c-vpill" style={{ padding: "6px 11px" }}>
              ↑ Open worker
            </Link>
            {/* TODO(#765): run share link — backend pending; honest stub for now. */}
            <button
              type="button"
              className="c-vpill"
              style={{ padding: "6px 11px" }}
              onClick={() => toast("Sharing a run is coming soon (#765).")}
            >
              Share
            </button>
            {/* #1274: confirm before replaying — avoids accidental duplicate runs. */}
            <button
              type="button"
              className="c-vpill"
              style={{ padding: "6px 11px" }}
              onClick={() => {
                if (!window.confirm("Re-run this worker with the same inputs?")) return;
                void replay(r);
              }}
            >
              Replay
            </button>
            {/* gap N2: Cancel an in-progress run — only shown while running/queued,
                wired to the real api.runs.cancel endpoint. */}
            {isCancellableRunStatus(r.status) && (
              <button
                type="button"
                className="c-vpill"
                style={{ padding: "6px 11px" }}
                onClick={() => void cancel(r)}
              >
                Cancel run
              </button>
            )}
          </>
        ),
      },
      // SPEC §4: tabs DERIVED from RUN_DETAIL_TABS so the contract test guards
      // the live tab set.
      tabs: RUN_DETAIL_TABS.map((key) => {
        const Tab = RUN_TAB_COMPONENT[key];
        return { key, label: key, render: () => <Tab r={r} /> };
      }),
    }),
    states: {
      // #1365 — add action CTA to runs empty state
      empty: {
        title: "No runs yet",
        help: "Runs appear here when your workers execute.",
        action: (
          <Link
            href="/workers/new"
            className="c-addbtn"
            style={{ display: "inline-block", marginTop: 8, padding: "6px 16px", fontSize: 13 }}
          >
            Create your first worker →
          </Link>
        ),
      },
    },
    // B37: "Load more" append footer — replaces numeric pagination.
    footer: hasMore ? (
      <div style={{ display: "flex", justifyContent: "center", paddingTop: 14 }}>
        <button
          type="button"
          className="c-vpill"
          style={{ padding: "8px 18px", fontSize: 13 }}
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      </div>
    ) : undefined,
  };

  return <Collection config={config} />;
}

const muted: React.CSSProperties = { color: "var(--muted-foreground)" };
const h4: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: ".05em",
  textTransform: "uppercase",
  color: "var(--muted-foreground)",
  margin: "0 0 9px",
};
const kv: React.CSSProperties = { display: "grid", gridTemplateColumns: "140px 1fr", gap: "9px 16px" };
const kvK: React.CSSProperties = { color: "var(--muted-foreground)", fontSize: 12.5 };
const code: React.CSSProperties = {
  border: "var(--bd-card)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-2)",
  color: "var(--ink-soft)",
  padding: 13,
  whiteSpace: "pre-wrap",
  overflow: "auto",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  maxHeight: 420,
};
