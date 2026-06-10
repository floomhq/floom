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
} from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection, Avatar } from "@/components/collection";
import { WorkerIconPills } from "@/components/WorkerIconPills";
import { WorkerAsciiDiagram } from "@/components/WorkerAsciiDiagram";
import { FilesEditor } from "@/components/worker-form/FilesEditor";
import { WorkerBrainEditor } from "@/components/worker/WorkerBrainEditor";
import { WorkerToolsEditor } from "@/components/worker/WorkerToolsEditor";
import { patchBrainContexts, patchWorkerConnections } from "@/lib/worker-manifest";
import { can, isViewOnly, canLeaveFeedback, visibilityLabel } from "@/lib/permissions";
import {
  isSystemWorker,
  workerStatusPill,
  workerTags,
  contentTagOptions,
} from "@/lib/workers/derive";
import { getFavorites, saveFavorites } from "@/lib/workers/favorites";

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

function AboutTab({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
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

function RunTab({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  if (!d) return <Loading />;
  const fields = d.config?.inputs ?? [];
  const submit = async () => {
    setRunning(true);
    try {
      const res = await api.workers.run(w.id, inputs);
      toast.success(res.run_id ? `Run started · #${res.run_id}` : "Run started");
    } catch {
      toast.error("Could not start the run.");
    } finally {
      setRunning(false);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 560 }}>
      {fields.length === 0 && <div style={muted}>This worker takes no inputs.</div>}
      {fields.map((f) => (
        <label key={f.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>{f.label || f.name}</span>
          <input
            className="c-srch"
            style={{ maxWidth: "none" }}
            value={inputs[f.name] ?? ""}
            onChange={(e) => setInputs((p) => ({ ...p, [f.name]: e.target.value }))}
            placeholder={f.name}
          />
        </label>
      ))}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          className="c-addbtn"
          disabled={running || d.enabled === false || !can("run", d)}
          onClick={() => void submit()}
          style={{ opacity: running ? 0.6 : 1 }}
        >
          {running ? "Running…" : "Run"}
        </button>
        {d.webhook_url && <span style={muted}>Webhook: {d.webhook_url}</span>}
      </div>
    </div>
  );
}

function RunsTab({ w }: { w: WorkerSummary }) {
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
          <div key={r.id} className="c-lrow" style={{ gridTemplateColumns: "1fr auto" }}>
            <div className="c-lprimary">
              <div className="c-lp-tx">
                <div className="nm">#{r.id}</div>
                <div className="sub">{r.status}</div>
              </div>
            </div>
            <span className="c-cell m">{rel(r.created_at)}</span>
          </div>
        ))}
        {runs.length === 0 && <div style={{ ...muted, padding: 14 }}>No runs yet.</div>}
      </div>
    </div>
  );
}

function SourceTab({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  if (!d) return <Loading />;
  const files = d.files ?? [];
  // Reuse the worker-form file viewer (syntax highlight + preview/raw + list).
  return (
    <FilesEditor
      mode="view"
      files={files}
      selectedPath={selectedPath ?? files[0]?.path ?? null}
      onSelect={setSelectedPath}
    />
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

function SettingsTab({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
  if (!d) return <Loading />;
  return (
    <div style={kv}>
      <span style={kvK}>Trigger</span>
      <span>{w.trigger_type}</span>
      <span style={kvK}>Runtime</span>
      <span>{w.runner}</span>
      {d.webhook_url && (
        <>
          <span style={kvK}>Webhook</span>
          <span style={{ fontFamily: "var(--font-mono)" }}>{d.webhook_url}</span>
        </>
      )}
      <span style={kvK}>Status</span>
      <span>{d.enabled === false ? "Paused" : "Enabled"}</span>
    </div>
  );
}

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
    items: visible,
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
      leading: <Avatar name={w.name} />,
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
      leading: <Avatar name={w.name} size={38} />,
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
          {can("run", w) && (
            <Link href={`/workers/${w.id}?tab=run`} className="c-addbtn" style={pillBtn}>
              Run
            </Link>
          )}
          {editable ? (
            <Link href={`/workers/${w.id}?edit=1`} className="c-vpill" style={pillBtn}>
              Edit
            </Link>
          ) : (
            canLeaveFeedback(w) && (
              <Link href={`/workers/${w.id}#feedback`} className="c-vpill" style={pillBtn}>
                Feedback
              </Link>
            )
          )}
          <Link href={`/workers/${w.id}`} className="c-vpill" style={pillBtn}>
            Open full page →
          </Link>
        </>
      );
      return {
        header: {
          leading: <Avatar name={w.name} size={42} />,
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
        tabs: [
          { key: "About", label: "About", render: () => <AboutTab w={w} /> },
          { key: "Run", label: "Run", render: () => <RunTab w={w} /> },
          { key: "Runs", label: "Runs", render: () => <RunsTab w={w} /> },
          { key: "Source", label: "Source", render: () => <SourceTab w={w} /> },
          { key: "Settings", label: "Settings", render: () => <SettingsTab w={w} /> },
          { key: "Brain", label: "Brain", render: () => <BrainTab w={w} /> },
          { key: "Tools", label: "Tools", render: () => <ToolsTab w={w} /> },
        ],
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
