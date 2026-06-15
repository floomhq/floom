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
import { formatRelative } from "@/lib/formatters";
import type { RunSummary, RunDetail, WorkerSummary } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { LoadingState } from "@/components/collection/CollectionStates";
import { InlineFileOpen } from "@/components/file-viewer/InlineFileOpen";
import { traceSteps } from "@/lib/runs/trace";
import { RUN_DETAIL_TABS, type RunDetailTab } from "@/lib/runs/tabs";
import { contentTagOptions } from "@/lib/workers/derive";
import {
  formatDuration,
  formatTrigger,
  triggerKey,
  runStatusPill,
  dayLabel,
  runSortTime,
  runsToCsvRows,
} from "@/lib/runs/format";

const detailCache = new Map<string, RunDetail>();

function useRunDetail(id: string): RunDetail | undefined {
  const [d, setD] = useState<RunDetail | undefined>(detailCache.get(id));
  useEffect(() => {
    if (detailCache.has(id)) {
      setD(detailCache.get(id));
      return;
    }
    let alive = true;
    api.runs
      .get(id)
      .then((rd) => {
        detailCache.set(id, rd);
        if (alive) setD(rd);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  return d;
}

// SPEC §4 Output: result + files; files open INLINE (breadcrumb/Back/Download);
// PNG artifacts render as images (shared InlineFileOpen, rule #5).
function OutputTab({ r }: { r: RunSummary }) {
  const d = useRunDetail(r.id);
  if (!d) return <LoadingState rows={4} />;
  const files = (d.artifacts ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    url: api.runs.artifactUrl(d.id, a.id),
    sizeBytes: a.size_bytes,
  }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {d.error && (
        <div className="c-pill err" style={{ alignSelf: "flex-start" }}>
          <span className="dot" />
          {d.error}
        </div>
      )}
      <div>
        <h4 style={h4}>Result</h4>
        <pre style={code}>{JSON.stringify(d.output ?? {}, null, 2)}</pre>
      </div>
      {files.length > 0 && (
        <div>
          <h4 style={h4}>Files</h4>
          <InlineFileOpen files={files} rootLabel="Output" />
        </div>
      )}
    </div>
  );
}

// SPEC §4 Trace: steps + logs. Transcript carries no per-step timestamps (no
// structured field), so durations come from the run-level timeline, not faked.

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

function TraceTab({ r }: { r: RunSummary }) {
  const d = useRunDetail(r.id);
  if (!d) return <LoadingState rows={4} />;
  const steps = traceSteps(d.transcript);
  const logs = d.logs ?? [];
  const tokenCount = resolveTokenCount(d);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={kv}>
        <span style={kvK}>Duration</span>
        <span>{formatDuration(d.duration_ms)}</span>
        <span style={kvK}>Tokens</span>
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {tokenCount != null ? tokenCount.toLocaleString() : "—"}
        </span>
      </div>
      <div>
        <h4 style={h4}>Steps</h4>
        <div className="c-ltable">
          {steps.map((s, i) => (
            <div key={i} className="c-lrow" style={{ gridTemplateColumns: "1fr" }}>
              <div className="c-lprimary">
                <div className="c-lp-tx">
                  <div className="nm">{s.label}</div>
                  <div className="sub" style={{ whiteSpace: "normal" }}>
                    {s.content}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {steps.length === 0 && <div style={{ ...muted, padding: 14 }}>No steps recorded.</div>}
        </div>
      </div>
      {logs.length > 0 && (
        <div>
          <h4 style={h4}>Logs</h4>
          <pre style={code}>
            {logs.map((l) => `${l.timestamp} [${l.level}] ${l.message}`).join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}

// SPEC §4: Inputs — the run's input payload.
function InputsTab({ r }: { r: RunSummary }) {
  const d = useRunDetail(r.id);
  if (!d) return <LoadingState rows={3} />;
  const input = d.input ?? {};
  if (Object.keys(input).length === 0) return <div style={muted}>This run took no inputs.</div>;
  return <pre style={code}>{JSON.stringify(input, null, 2)}</pre>;
}

// SPEC §4: Raw — the full run record.
function RawTab({ r }: { r: RunSummary }) {
  const d = useRunDetail(r.id);
  if (!d) return <LoadingState rows={4} />;
  return <pre style={code}>{JSON.stringify(d, null, 2)}</pre>;
}

// Tab key → its (named) component, keyed by RUN_DETAIL_TABS so the §4 contract
// test guards the live tab set.
const RUN_TAB_COMPONENT: Record<RunDetailTab, (props: { r: RunSummary }) => React.ReactNode> = {
  Output: OutputTab,
  Trace: TraceTab,
  Inputs: InputsTab,
  Raw: RawTab,
};

const PAGE_SIZE = 50;

export default function RunsCollection({ initialRuns }: { initialRuns: RunSummary[] }) {
  const [runs, setRuns] = useState<RunSummary[]>(initialRuns);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [loading, setLoading] = useState(initialRuns.length === 0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(initialRuns.length === 0); // unknown until first fetch
  const [offset, setOffset] = useState(0);
  const [now] = useState(() => Date.now());

  // Initial load: fetch first page and set hasMore based on whether a full page was returned.
  const loadInitial = useCallback(async () => {
    try {
      const rows = await api.runs.list({ limit: PAGE_SIZE, offset: 0 });
      const sorted = [...rows].sort((a, b) => runSortTime(b) - runSortTime(a));
      setRuns(sorted);
      setOffset(PAGE_SIZE);
      setHasMore(rows.length === PAGE_SIZE);
    } catch {
      // leave existing state intact on refresh errors
    } finally {
      setLoading(false);
    }
  }, []);

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
      await loadInitial();
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
    void loadInitial();
    // Content tags are inherited from the parent worker (SPEC §11).
    api.workers.list().then(setWorkers).catch(() => {});
  }, [loadInitial]);

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

  const config: CollectionConfig<RunSummary> = {
    title: "Run history",
    subtitle: "Worker executions grouped by day.",
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
    group: (r) => dayLabel(r.created_at ?? r.started_at, now),
    columns: {
      template: "1.6fr 1fr .8fr 130px 1fr",
      headers: ["Worker", "Trigger", "Duration", "Status", "Started"],
      statusColumn: false,
      menuColumn: false,
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
        sub: (
          <span className="c-dh-sub" style={{ margin: 0 }}>
            {formatTrigger(r.trigger_source)} · {formatDuration(r.duration_ms)} ·{" "}
            {formatRelative(r.created_at ?? r.started_at ?? "")}
          </span>
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
      empty: { title: "No runs yet", help: "Runs appear here when your workers execute." },
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
