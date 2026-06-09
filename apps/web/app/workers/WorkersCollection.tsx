"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { WorkerSummary, WorkerDetail } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection, Avatar } from "@/components/collection";
import { WorkerIconPills } from "@/components/WorkerIconPills";
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

function useWorkerDetail(id: string): WorkerDetail | undefined {
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
  return detail;
}

const SOURCE_FILES: { key: string; label: string; pick: (d: WorkerDetail) => string | undefined }[] = [
  { key: "yml", label: "worker.yml", pick: (d) => d.manifest_yaml },
  { key: "skill", label: "SKILL.md", pick: (d) => d.skill_md_content },
  { key: "run", label: "run.py", pick: (d) => d.run_py_content || d.run_py },
  {
    key: "req",
    label: "requirements.txt",
    pick: (d) => d.files?.find((f) => f.path.endsWith("requirements.txt"))?.content,
  },
];

function Loading() {
  return <div style={muted}>Loading…</div>;
}

function AboutTab({ w }: { w: WorkerSummary }) {
  const d = useWorkerDetail(w.id);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
  const d = useWorkerDetail(w.id);
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
  const d = useWorkerDetail(w.id);
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
  const d = useWorkerDetail(w.id);
  const [sub, setSub] = useState("yml");
  if (!d) return <Loading />;
  const active = SOURCE_FILES.find((f) => f.key === sub) ?? SOURCE_FILES[0];
  return (
    <div>
      <div style={{ display: "flex", gap: 2, marginBottom: 12, flexWrap: "wrap" }}>
        {SOURCE_FILES.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`c-dtab ${f.key === sub ? "on" : ""}`}
            onClick={() => setSub(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <pre style={code}>{active.pick(d) || "(empty)"}</pre>
    </div>
  );
}

function BrainTab({ w }: { w: WorkerSummary }) {
  const d = useWorkerDetail(w.id);
  if (!d) return <Loading />;
  const contexts = d.config?.contexts ?? [];
  return (
    <div className="c-ltable">
      {contexts.map((c, i) => {
        const name = typeof c === "string" ? c : (c as { name?: string }).name ?? "context";
        const writeable = typeof c === "object" && (c as { writeable?: boolean }).writeable;
        return (
          <div key={i} className="c-lrow" style={{ gridTemplateColumns: "1fr auto" }}>
            <div className="c-lprimary">
              <div className="c-lp-tx">
                <div className="nm">{name}</div>
              </div>
            </div>
            <span className="c-vpill">{writeable ? "Read & write" : "Read only"}</span>
          </div>
        );
      })}
      {contexts.length === 0 && <div style={{ ...muted, padding: 14 }}>No brain folders attached.</div>}
    </div>
  );
}

function ToolsTab({ w }: { w: WorkerSummary }) {
  const conns = w.connections ?? [];
  return (
    <div className="c-ltable">
      {conns.map((c) => (
        <div key={c} className="c-lrow" style={{ gridTemplateColumns: "1fr" }}>
          <div className="c-lprimary">
            <div className="c-lp-tx">
              <div className="nm" style={{ textTransform: "capitalize" }}>
                {c}
              </div>
              <div className="sub">via connection</div>
            </div>
          </div>
        </div>
      ))}
      {conns.length === 0 && <div style={{ ...muted, padding: 14 }}>No tools connected.</div>}
    </div>
  );
}

function SettingsTab({ w }: { w: WorkerSummary }) {
  const d = useWorkerDetail(w.id);
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
const pillBtn: React.CSSProperties = { padding: "6px 11px", fontSize: 12.5 };
