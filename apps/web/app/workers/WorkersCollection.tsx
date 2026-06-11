"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type {
  WorkerSummary,
  WorkerDetail,
  WorkerContextSpec,
  WorkerConnectionSpec,
  VersionSummary,
  RunSummary,
} from "@/lib/types";
import { formatVersionRows } from "@/lib/workers/versions";
import { WORKER_DETAIL_TABS, type WorkerDetailTab } from "@/lib/workers/tabs";
import { formatDuration } from "@/lib/runs/format";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { Lock } from "lucide-react";
import { WorkerIconPills } from "@/components/WorkerIconPills";
import { WorkerAsciiDiagram } from "@/components/WorkerAsciiDiagram";
import { CodeBlock } from "@/components/file-viewer/code-block";
import { WorkerBrainEditor } from "@/components/worker/WorkerBrainEditor";
import { WorkerToolsEditor } from "@/components/worker/WorkerToolsEditor";
import { WorkerFeedbackPanel } from "@/components/worker/WorkerFeedbackPanel";
import { patchBrainContexts, patchWorkerConnections } from "@/lib/worker-manifest";
import { can, isViewOnly, canLeaveFeedback, visibilityLabel, FEEDBACK_BACKEND_AVAILABLE } from "@/lib/permissions";
import {
  isSystemWorker,
  workerStatusPill,
  workerTags,
  contentTagOptions,
  orderedSourceFiles,
} from "@/lib/workers/derive";
import { getFavorites, saveFavorites } from "@/lib/workers/favorites";
import { sortWorkersByRecentActivity } from "@/lib/worker-list-order";

function rel(ts?: string | null): string {
  if (!ts) return "—";
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return "—";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ---- detail (lazy WorkerDetail, cached so tab switches don't refetch) ----
const detailCache = new Map<string, WorkerDetail>();

function useWorkerDetail(id: string): [WorkerDetail | undefined, (d: WorkerDetail) => void] {
  const [detail, setDetail] = useState<WorkerDetail | undefined>(detailCache.get(id));
  useEffect(() => {
    if (detailCache.has(id)) {
      setDetail(detailCache.get(id));
      return;
    }
    let alive = true;
    api.workers
      .get(id)
      .then((d) => {
        detailCache.set(id, d);
        if (alive) setDetail(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  const apply = useCallback(
    (d: WorkerDetail) => {
      detailCache.set(id, d);
      setDetail(d);
    },
    [id],
  );
  return [detail, apply];
}

/** Build the worker.yml text from a detail (files take precedence). */
function workerYml(d: WorkerDetail): string {
  return d.files?.find((f) => f.path === "worker.yml")?.content || d.manifest_yaml || "";
}

/** Persist a patched worker.yml via updateFiles, returning the saved detail. */
async function persistYml(d: WorkerDetail, patchedYml: string): Promise<WorkerDetail> {
  const text = (d.files ?? [])
    .filter((f) => !f.binary && f.content != null)
    .map((f) => ({ path: f.path, content: f.content as string }));
  const files = text.some((f) => f.path === "worker.yml")
    ? text.map((f) => (f.path === "worker.yml" ? { ...f, content: patchedYml } : f))
    : [{ path: "worker.yml", content: patchedYml }, ...text];
  return api.workers.updateFiles(d.id, files);
}

function Loading() {
  return <div style={muted}>Loading…</div>;
}

// SPEC §4 + rule #4: Overview is OUTPUT-FIRST — latest result/artifacts and an
// "All runs →" link lead; the "what it does" flow follows. The actual output
// text/artifact preview needs `last_run.output_preview` (#815); until then we
// surface the latest run's status/time and link into Runs for the full output.
function LatestOutput({ w, d }: { w: WorkerSummary; d?: WorkerDetail }) {
  const last: RunSummary | undefined = d?.recent_runs?.[0] ?? w.last_run;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 9 }}>
        <h4 style={{ ...h4, margin: 0 }}>Latest output</h4>
        <Link
          href={`/runs?worker_id=${w.id}`}
          className="c-vpill"
          style={{ marginLeft: "auto", padding: "5px 9px" }}
        >
          All runs →
        </Link>
      </div>
      {last ? (
        <Link
          href={`/runs?worker_id=${w.id}&sel=${last.id}`}
          className="c-ltable"
          style={{ display: "block", textDecoration: "none", color: "inherit" }}
        >
          <div className="c-lrow" style={{ gridTemplateColumns: "1fr auto auto", gap: 12 }}>
            <div className="c-lprimary">
              <div className="c-lp-tx">
                <div className="nm">Run #{last.id}</div>
                <div className="sub">{last.status}</div>
              </div>
            </div>
            <span className="c-cell m">{formatDuration(last.duration_ms)}</span>
            <span className="c-cell m">{rel(last.created_at)}</span>
          </div>
        </Link>
      ) : (
        <div className="c-ltable" style={{ padding: 14, ...muted }}>
          No runs yet. Run this worker to see its latest output here.
        </div>
      )}
      {/* TODO(#815): render last_run.output_preview (result text + artifact chips) inline. */}
    </div>
  );
}

function OverviewTab({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <LatestOutput w={w} d={d} />
      <div>
        <h4 style={h4}>What it does</h4>
        <AboutBody w={w} d={d} />
      </div>
    </div>
  );
}

function AboutBody({ w, d }: { w: WorkerSummary; d?: WorkerDetail }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <WorkerAsciiDiagram
        workerName={w.name}
        worker={{ id: w.id, name: w.name, connections: w.connections, tags: w.tags }}
        connections={w.connections}
        triggerType={w.trigger_type}
        inputs={(d?.config?.inputs ?? []).map((i) => ({ name: i.name, label: i.label, type: i.type }))}
        outputs={(d?.config?.outputs ?? []).map((o) => ({ name: o.name, label: o.label, type: o.type }))}
      />
      <p style={{ margin: 0 }}>{w.long_description || w.description || "No description yet."}</p>
      {d?.use_cases && d.use_cases.length > 0 && (
        <div>
          <h4 style={h4}>Use cases</h4>
          <ul style={{ margin: 0, paddingLeft: 18, color: "var(--ink-soft)" }}>
            {d.use_cases.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {d?.how_it_works && (
        <div>
          <h4 style={h4}>How it works</h4>
          <p style={{ margin: 0, color: "var(--ink-soft)" }}>{d.how_it_works}</p>
        </div>
      )}
    </div>
  );
}


// SPEC §4 History: recent runs w/ durations, link to Runs.
function HistoryTab({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
  const runs = d?.recent_runs ?? (w.last_run ? [w.last_run] : []);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 9 }}>
        <h4 style={{ ...h4, margin: 0 }}>Recent runs</h4>
        <Link href={`/runs?worker_id=${w.id}`} className="c-vpill" style={{ marginLeft: "auto", padding: "5px 9px" }}>
          All runs →
        </Link>
      </div>
      <div className="c-ltable">
        {runs.map((r) => (
          <Link
            key={r.id}
            href={`/runs?worker_id=${w.id}&sel=${r.id}`}
            className="c-lrow"
            style={{ gridTemplateColumns: "1fr auto auto", gap: 12, textDecoration: "none", color: "inherit" }}
          >
            <div className="c-lprimary">
              <div className="c-lp-tx">
                <div className="nm">#{r.id}</div>
                <div className="sub">{r.status}</div>
              </div>
            </div>
            <span className="c-cell m">{formatDuration(r.duration_ms)}</span>
            <span className="c-cell m">{rel(r.created_at)}</span>
          </Link>
        ))}
        {runs.length === 0 && <div style={{ ...muted, padding: 14 }}>No runs yet.</div>}
      </div>
    </div>
  );
}

// SPEC §4 Versions: git log in the GLOBAL list style — message + `sha · author ·
// age`, current marker, Diff (modal) + Restore (confirm). Endpoints BUILT.
function VersionsTab({ w }: { w: WorkerSummary }) {
  const [, applyDetail] = useWorkerDetail(w.id);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [diff, setDiff] = useState<{ id: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());
  const editable = can("edit", w);

  useEffect(() => {
    let alive = true;
    api.workers
      .listVersions(w.id)
      .then((v) => alive && setVersions(v))
      .catch(() => alive && setVersions([]));
    return () => {
      alive = false;
    };
  }, [w.id]);

  if (!versions) return <Loading />;
  if (versions.length === 0) return <div style={muted}>No version history yet.</div>;
  const rows = formatVersionRows(versions, now);

  const showDiff = async (id: string) => {
    try {
      const v = await api.workers.getVersion(w.id, id);
      const file = v.files?.find((f) => f.path === "worker.yml") ?? v.files?.[0];
      setDiff({ id, content: file?.content ?? "" });
    } catch {
      toast.error("Could not load that version.");
    }
  };
  const restore = async (id: string) => {
    if (!window.confirm(`Restore worker to version ${id.slice(0, 7)}? This commits a new version.`)) return;
    setBusy(true);
    try {
      applyDetail(await api.workers.rollback(w.id, id));
      toast.success(`Restored to ${id.slice(0, 7)}`);
      setVersions(await api.workers.listVersions(w.id));
    } catch {
      toast.error("Could not restore that version.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="c-ltable">
        {rows.map((r) => (
          <div key={r.id} className="c-lrow" style={{ gridTemplateColumns: "1fr auto" }}>
            <div className="c-lprimary">
              <div className="c-lp-tx">
                <div className="nm">
                  {r.message}
                  {r.isCurrent && <span className="c-vpill" style={{ marginLeft: 8 }}>current</span>}
                </div>
                <div className="sub">{r.meta}</div>
              </div>
            </div>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button type="button" className="c-vpill" style={pillBtn} onClick={() => void showDiff(r.id)}>
                Diff
              </button>
              {editable && !r.isCurrent && (
                <button
                  type="button"
                  className="c-vpill"
                  style={pillBtn}
                  disabled={busy}
                  onClick={() => void restore(r.id)}
                >
                  Restore
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      <Dialog open={!!diff} onOpenChange={(o) => !o && setDiff(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Version {diff?.id.slice(0, 7)}</DialogTitle>
          </DialogHeader>
          {diff && <CodeBlock text={diff.content} filePath="worker.yml" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// SPEC §11: Source is file SUB-TABS (worker.yml/SKILL.md/run.py/requirements.txt),
// NOT a left-sidebar file list.
function SourceTab({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
  const [active, setActive] = useState<string | null>(null);
  if (!d) return <Loading />;
  const ordered = orderedSourceFiles(d.files ?? []);
  if (ordered.length === 0) return <div style={muted}>No source files.</div>;
  const file = ordered.find((f) => f.path === active) ?? ordered[0];
  return (
    <div>
      <div style={{ display: "flex", gap: 2, marginBottom: 12, flexWrap: "wrap" }}>
        {ordered.map((f) => (
          <button
            key={f.path}
            type="button"
            className={`c-dtab ${f.path === file.path ? "on" : ""}`}
            onClick={() => setActive(f.path)}
          >
            {f.path}
          </button>
        ))}
      </div>
      <CodeBlock text={file.content ?? ""} filePath={file.path} language={file.language} />
    </div>
  );
}

function BrainTab({ w }: { w: WorkerSummary }) {
  const [d, applyDetail] = useWorkerDetail(w.id);
  const [packs, setPacks] = useState<{ name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.contexts.list().then(setPacks).catch(() => {});
  }, []);
  if (!d) return <Loading />;
  const editable = can("edit", d);
  const save = async (next: WorkerContextSpec[]) => {
    setBusy(true);
    try {
      applyDetail(await persistYml(d, patchBrainContexts(workerYml(d), next)));
      toast.success("Brain updated");
    } catch {
      toast.error("Could not update brain folders.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <WorkerBrainEditor
      contexts={d.config?.contexts ?? []}
      availablePacks={packs}
      editable={editable}
      busy={busy}
      onChange={(next) => void save(next)}
    />
  );
}

function ToolsTab({ w }: { w: WorkerSummary }) {
  const [d, applyDetail] = useWorkerDetail(w.id);
  const [busy, setBusy] = useState(false);
  if (!d) return <Loading />;
  const editable = can("edit", d);
  const save = async (next: WorkerConnectionSpec[]) => {
    setBusy(true);
    try {
      applyDetail(await persistYml(d, patchWorkerConnections(workerYml(d), next)));
      toast.success("Tools updated");
    } catch {
      toast.error("Could not update tools.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <WorkerToolsEditor
      connections={d.config?.connections ?? []}
      editable={editable}
      busy={busy}
      onChange={(next) => void save(next)}
    />
  );
}

// SPEC §4 Config: Tools · Brain attach · Triggers · Limits in one tab.
// ("paused" = enabled:false — there is no paused status; pause/resume is #788;
// spend cap is #793; PATCH name/desc is #785; brain attach/detach is #790 —
// today these route through the full worker-YAML PUT.)
function ConfigTab({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
  if (!d) return <Loading />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <section>
        <h4 style={h4}>Tools</h4>
        <ToolsTab w={w} />
      </section>
      <section>
        <h4 style={h4}>Brain</h4>
        <BrainTab w={w} />
      </section>
      <section>
        <h4 style={h4}>Triggers</h4>
        <div style={kv}>
          <span style={kvK}>Trigger</span>
          <span>{w.trigger_type}</span>
          {d.webhook_url && (
            <>
              <span style={kvK}>Webhook</span>
              <span style={{ fontFamily: "var(--font-mono)" }}>{d.webhook_url}</span>
            </>
          )}
          <span style={kvK}>Status</span>
          {/* TODO(#788): pause/resume toggle — "paused" is enabled:false today. */}
          <span>{d.enabled === false ? "Paused" : "Enabled"}</span>
        </div>
      </section>
      <section>
        <h4 style={h4}>Limits</h4>
        <div style={kv}>
          <span style={kvK}>Runtime</span>
          <span>{w.runner}</span>
          {/* TODO(#793): monthly spend cap field. */}
        </div>
      </section>
      {FEEDBACK_BACKEND_AVAILABLE && (
        <section>
          <h4 style={h4}>Feedback</h4>
          <WorkerFeedbackPanel workerId={w.id} canLeave={canLeaveFeedback(w)} canModerate={can("edit", w)} />
        </section>
      )}
    </div>
  );
}

// Tab key → its (named) component, keyed by WORKER_DETAIL_TABS so the §4
// contract test guards the live tab set, not a parallel constant.
const WORKER_TAB_COMPONENT: Record<WorkerDetailTab, (props: { w: WorkerSummary }) => React.ReactNode> = {
  Overview: OverviewTab,
  History: HistoryTab,
  Source: SourceTab,
  Versions: VersionsTab,
  Config: ConfigTab,
};

export default function WorkersCollection({
  initialWorkers,
}: {
  initialWorkers: WorkerSummary[];
}) {
  const [workers, setWorkers] = useState<WorkerSummary[]>(initialWorkers);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());

  useEffect(() => {
    setFavorites(getFavorites());
    api.workers
      .list({ include_archived: true })
      .then((all) => setWorkers(all.filter((w) => !isSystemWorker(w))))
      .catch(() => {});
  }, []);

  const toggleStar = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveFavorites(next);
      return next;
    });
  }, []);

  // Stamp "now" once (for the Recent smart tag) — Date.now() is impure in render.
  const [now] = useState(() => Date.now());
  const visible = useMemo(() => workers.filter((w) => !isSystemWorker(w)), [workers]);

  const config: CollectionConfig<WorkerSummary> = {
    title: "Workers",
    subtitle: "Your AI workers.",
    items: sortWorkersByRecentActivity(visible),
    idOf: (w) => w.id,
    searchOf: (w) => `${w.name} ${w.description ?? ""} ${(w.tags ?? []).join(" ")}`,
    tagsOf: (w) =>
      workerTags(w, { starred: favorites.has(w.id), now }) as Partial<Record<TagFamilyKey, string[]>>,
    tags: {
      smart: [
        { value: "starred", label: "Starred" },
        { value: "recent", label: "Recent" },
        { value: "archived", label: "Archived" },
      ],
      status: [
        { value: "running", label: "running" },
        { value: "failing", label: "failing" },
        { value: "needs-attention", label: "needs attention" },
      ],
      visibility: [
        { value: "private", label: "Private" },
        { value: "shared", label: "Shared" },
      ],
      content: contentTagOptions(visible),
    },
    counts: [
      { value: visible.length, label: "workers" },
      { value: visible.filter((w) => w.status === "healthy" || w.status === "ready").length, label: "active" },
      {
        value: visible.filter((w) => w.status === "needs_attention" || w.status === "missing_secret").length,
        label: "needs attention",
      },
    ],
    view: { default: "grid", grid: true },
    columns: {
      template: "1.8fr 1fr 1fr 140px 40px",
      headers: ["Worker", "Tools", "Last run", "Status", ""],
    },
    row: (w) => ({
      // V4 SPEC rule 3: no avatar for workers; lock icon shown when private only.
      leading: w.visibility === "private" ? <Lock className="size-4 text-[var(--muted-foreground)]" /> : undefined,
      primary: w.name,
      secondary: w.description,
      cols: [
        <WorkerIconPills key="t" worker={{ id: w.id, name: w.name, connections: w.connections }} max={3} />,
        rel(w.recent_stats?.last_run_at),
      ],
      status: workerStatusPill(w),
      menu: [{ label: "Open", onSelect: () => (window.location.href = `/workers/${w.id}`) }],
    }),
    card: (w) => ({
      // V4 SPEC rule 3: no avatar monogram; name carries lock icon inline when private.
      // Lock is surfaced via `leading` only when private; workspace is silent default.
      leading: w.visibility === "private" ? <Lock className="size-3.5 text-[var(--muted-foreground)]" /> : undefined,
      name: w.name,
      description: w.description,
      status: workerStatusPill(w),
      toolLogos: <WorkerIconPills worker={{ id: w.id, name: w.name, connections: w.connections }} max={3} />,
      star: { on: favorites.has(w.id), onToggle: () => toggleStar(w.id) },
    }),
    detail: (w) => {
      const editable = can("edit", w);
      const viewOnly = isViewOnly(w);
      const actions = (
        <>
          {/* SPEC §4: Run opens the inputs flow on the full worker page (the
              dedicated Run-with-inputs modal is §5). */}
          {can("run", w) && (
            <Link href={`/workers/${w.id}#run`} className="c-addbtn" style={pillBtn}>
              Run
            </Link>
          )}
          {editable && (
            <Link href={`/workers/${w.id}?edit=1`} className="c-vpill" style={pillBtn}>
              Edit
            </Link>
          )}
          <Link href={`/workers/${w.id}`} className="c-vpill" style={pillBtn}>
            Open full page →
          </Link>
        </>
      );
      return {
        header: {
          // V4 SPEC rule 3: no avatar monogram in detail header either.
          leading: w.visibility === "private" ? <Lock className="size-4 text-[var(--muted-foreground)]" /> : undefined,
          title: w.name,
          actions,
          sub: (
            <>
              <span className="c-vpill">{visibilityLabel(w.visibility)}</span>
              {viewOnly && (
                <span className="c-vpill" style={{ color: "var(--warning)", borderColor: "var(--warning)" }}>
                  View only
                </span>
              )}
              <span className="c-dh-sub" style={{ margin: 0 }}>
                {w.description}
              </span>
            </>
          ),
        },
        // SPEC §4: tabs are DERIVED from WORKER_DETAIL_TABS so the contract test
        // guards what actually renders (no drift between constant and component).
        tabs: WORKER_DETAIL_TABS.map((key) => {
          const Tab = WORKER_TAB_COMPONENT[key];
          return { key, label: key, render: () => <Tab w={w} /> };
        }),
      };
    },
    add: {
      label: "New worker",
      onSelect: () => (window.location.href = "/workers/new"),
    },
    states: {
      empty: { title: "No workers yet", help: "Create your first worker to get started." },
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
const pillBtn: React.CSSProperties = { padding: "6px 11px", fontSize: 12.5 };
