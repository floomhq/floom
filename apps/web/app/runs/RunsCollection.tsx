"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import Papa from "papaparse";
import { Download } from "lucide-react";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/formatters";
import type { RunSummary, RunDetail, WorkerSummary } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection, Avatar } from "@/components/collection";
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

function OutputTab({ r }: { r: RunSummary }) {
  const d = useRunDetail(r.id);
  if (!d) return <div style={muted}>Loading…</div>;
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
      {d.artifacts?.length > 0 && (
        <div>
          <h4 style={h4}>Files</h4>
          <div className="c-ltable">
            {d.artifacts.map((a) => (
              <a
                key={a.id}
                href={api.runs.artifactUrl(d.id, a.id)}
                className="c-lrow"
                style={{ gridTemplateColumns: "1fr auto", textDecoration: "none" }}
              >
                <div className="c-lprimary">
                  <div className="c-lp-tx">
                    <div className="nm" style={{ fontFamily: "var(--font-mono)" }}>
                      {a.name}
                    </div>
                  </div>
                </div>
                <span className="c-cell m">{a.size_bytes ? `${Math.round(a.size_bytes / 1024)} KB` : ""}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StepsTab({ r }: { r: RunSummary }) {
  const d = useRunDetail(r.id);
  if (!d) return <div style={muted}>Loading…</div>;
  const steps = d.transcript ?? [];
  return (
    <div className="c-ltable">
      {steps.map((s, i) => (
        <div key={i} className="c-lrow" style={{ gridTemplateColumns: "1fr" }}>
          <div className="c-lprimary">
            <div className="c-lp-tx">
              <div className="nm">{(s as { role?: string }).role ?? `Step ${i + 1}`}</div>
              <div className="sub" style={{ whiteSpace: "normal" }}>
                {String((s as { content?: unknown }).content ?? "").slice(0, 240)}
              </div>
            </div>
          </div>
        </div>
      ))}
      {steps.length === 0 && <div style={{ ...muted, padding: 14 }}>No steps recorded.</div>}
    </div>
  );
}

function ToolsTab({ r }: { r: RunSummary }) {
  const d = useRunDetail(r.id);
  if (!d) return <div style={muted}>Loading…</div>;
  const calls = d.tool_calls ?? [];
  return (
    <div className="c-ltable">
      {calls.map((t) => (
        <div key={t.id} className="c-lrow" style={{ gridTemplateColumns: "1fr auto" }}>
          <div className="c-lprimary">
            <div className="c-lp-tx">
              <div className="nm" style={{ fontFamily: "var(--font-mono)" }}>
                {t.name}
              </div>
              <div className="sub" style={{ whiteSpace: "normal" }}>
                {JSON.stringify(t.arguments).slice(0, 200)}
              </div>
            </div>
          </div>
          {t.error ? (
            <span className="c-pill err">
              <span className="dot" />
              error
            </span>
          ) : (
            <span className="c-pill ok">
              <span className="dot" />
              ok
            </span>
          )}
        </div>
      ))}
      {calls.length === 0 && <div style={{ ...muted, padding: 14 }}>No tool calls in this run.</div>}
    </div>
  );
}

function CostTab({ r }: { r: RunSummary }) {
  const d = useRunDetail(r.id);
  if (!d) return <div style={muted}>Loading…</div>;
  return (
    <div style={kv}>
      <span style={kvK}>Tokens</span>
      <span style={{ fontFamily: "var(--font-mono)" }}>{d.total_tokens ?? "—"}</span>
      <span style={kvK}>Duration</span>
      <span>{formatDuration(d.duration_ms)}</span>
      <span style={kvK}>Runner</span>
      <span>{d.runner}</span>
    </div>
  );
}

export default function RunsCollection({ initialRuns }: { initialRuns: RunSummary[] }) {
  const [runs, setRuns] = useState<RunSummary[]>(initialRuns);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [now] = useState(() => Date.now());

  const refresh = () =>
    api.runs
      .list({ limit: 200 })
      .then((rows) => setRuns([...rows].sort((a, b) => runSortTime(b) - runSortTime(a))))
      .catch(() => {});

  useEffect(() => {
    void refresh();
    // Content tags are inherited from the parent worker (SPEC §11).
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

  const cancel = async (r: RunSummary) => {
    try {
      await api.runs.cancel(r.id);
      toast.success("Run cancelled");
      await refresh();
    } catch {
      toast.error("Could not cancel the run.");
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
    idOf: (r) => r.id,
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
    view: { default: "list", grid: true },
    toolbarActions: (
      <button type="button" className="c-vpill" style={{ padding: "9px 12px" }} onClick={() => void exportCSV()}>
        <Download size={14} /> Export CSV
      </button>
    ),
    group: (r) => dayLabel(r.created_at ?? r.started_at, now),
    columns: {
      template: "1.6fr 1fr .8fr 1fr 130px 40px",
      headers: ["Worker", "Trigger", "Duration", "Started", "Status", ""],
    },
    row: (r) => ({
      leading: <Avatar name={r.worker_name ?? r.worker_id} />,
      primary: r.worker_name ?? r.worker_id,
      cols: [
        formatTrigger(r.trigger_source),
        formatDuration(r.duration_ms),
        formatRelative(r.created_at ?? r.started_at ?? ""),
      ],
      status: runStatusPill(r.status),
      menu:
        r.status === "running" || r.status === "queued"
          ? [{ label: "Cancel run", onSelect: () => void cancel(r), danger: true }]
          : [{ label: "Open full run", onSelect: () => (window.location.href = `/runs/${r.id}`) }],
    }),
    card: (r) => ({
      leading: <Avatar name={r.worker_name ?? r.worker_id} size={38} />,
      name: r.worker_name ?? r.worker_id,
      description: `${formatTrigger(r.trigger_source)} · ${formatDuration(r.duration_ms)}`,
      status: runStatusPill(r.status),
    }),
    detail: (r) => ({
      header: {
        leading: <Avatar name={r.worker_name ?? r.worker_id} size={42} />,
        title: r.worker_name ?? r.worker_id,
        sub: (
          <span className="c-dh-sub" style={{ margin: 0 }}>
            {formatTrigger(r.trigger_source)} · {formatDuration(r.duration_ms)} ·{" "}
            {formatRelative(r.created_at ?? r.started_at ?? "")}
          </span>
        ),
        actions: (
          <>
            <button
              type="button"
              className="c-vpill"
              style={{ padding: "6px 11px" }}
              onClick={() => void replay(r)}
            >
              Replay
            </button>
            <Link href={`/runs/${r.id}`} className="c-vpill" style={{ padding: "6px 11px" }}>
              Open full run →
            </Link>
          </>
        ),
      },
      tabs: [
        { key: "Output", label: "Output", render: () => <OutputTab r={r} /> },
        { key: "Steps", label: "Steps", render: () => <StepsTab r={r} /> },
        { key: "Tools", label: "Tools", render: () => <ToolsTab r={r} /> },
        { key: "Cost", label: "Cost", render: () => <CostTab r={r} /> },
      ],
    }),
    states: {
      empty: { title: "No runs yet", help: "Runs appear here when your workers execute." },
    },
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
  border: "1px solid var(--line)",
  borderRadius: 12,
  background: "var(--bg-2)",
  color: "var(--ink-soft)",
  padding: 13,
  whiteSpace: "pre-wrap",
  overflow: "auto",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  maxHeight: 420,
};
