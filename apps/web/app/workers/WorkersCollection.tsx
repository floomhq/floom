"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type {
  WorkerSummary,
  WorkerDetail,
  WorkerContextSpec,
  WorkerConnectionSpec,
  WorkerFile,
  VersionSummary,
  RunSummary,
  TriggerSpec,
  WorkerInput,
} from "@/lib/types";
import { formatVersionRows } from "@/lib/workers/versions";
import { WORKER_DETAIL_TABS, type WorkerDetailTab } from "@/lib/workers/tabs";
import { formatDuration } from "@/lib/runs/format";
import { modelLabel } from "@/lib/model-labels";
import { runtimeSummary } from "@/lib/runtime-labels";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { LoadingState } from "@/components/collection/CollectionStates";
import { ArrowRight, Brain, ChevronDown, ChevronUp, FileText, Lock, MoreHorizontal, UploadCloud } from "lucide-react";
import { BRAIN_FILE_META, inferBrainFileType } from "@/lib/brain/file-type-icon";
import { WorkerIconPills } from "@/components/WorkerIconPills";
import { Sparkline } from "@/components/Sparkline";
import { WorkerAsciiDiagram } from "@/components/WorkerAsciiDiagram";
import { CodeBlock } from "@/components/file-viewer/code-block";
import {
  FilesEditor,
  TriggersEditor,
  makeTriggerRow,
  buildTriggersYaml,
  replaceTriggerBlock,
  type TriggerRow,
} from "@/components/worker-form";
import { WorkerBrainEditor } from "@/components/worker/WorkerBrainEditor";
import { WorkerToolsEditor } from "@/components/worker/WorkerToolsEditor";
import { WorkerFeedbackPanel } from "@/components/worker/WorkerFeedbackPanel";
import { VersionDiffPanel } from "@/components/VersionDiffPanel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  contextSpecName,
  patchBrainContexts,
  patchWorkerConnections,
  setContextWriteable,
  toggleContext,
} from "@/lib/worker-manifest";
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

/** Build the muted telemetry string for B17 worker card meta line. */
function workerCardMeta(w: WorkerSummary): string | null {
  const s = w.recent_stats;
  if (!s) return null;
  const parts: string[] = [];
  if (s.last_run_at) parts.push(rel(s.last_run_at));
  if (typeof s.runs_7d === "number" && s.runs_7d > 0) parts.push(`${s.runs_7d} run${s.runs_7d === 1 ? "" : "s"}`);
  if (typeof s.success_rate_7d === "number" && s.runs_7d > 0) {
    parts.push(`${Math.round(s.success_rate_7d * 100)}%`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function displayBrandCopy(value?: string | null): string {
  const legacyAllCapsSuffix = new RegExp(`\\bWorker${"OS"}\\b`, "g");
  const legacyTitle = new RegExp(`\\bWorker${"os"}\\b`, "g");
  return (value ?? "").replace(legacyAllCapsSuffix, "Floom").replace(legacyTitle, "Floom");
}

// ---- detail (lazy WorkerDetail, cached so tab switches don't refetch) ----
const detailCache = new Map<string, WorkerDetail>();

// Returns [detail, apply] where detail is:
//   undefined → still loading
//   null      → load failed (show an error/empty state)
//   WorkerDetail → loaded
function useWorkerDetail(id: string): [WorkerDetail | undefined | null, (d: WorkerDetail) => void] {
  const [detail, setDetail] = useState<WorkerDetail | undefined | null>(detailCache.get(id));
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
      .catch(() => {
        // null signals "failed to load" so tabs show an error state instead of
        // spinning forever (#1279).
        if (alive) setDetail(null);
      });
    // Safety timeout: if the API proxy hangs, surface an error after 10 s.
    const timeout = setTimeout(() => {
      if (alive && detail === undefined) setDetail(null);
    }, 10_000);
    return () => {
      alive = false;
      clearTimeout(timeout);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

function patchTopLevelScalar(yaml: string, key: string, value: string): string {
  const line = `${key}: ${JSON.stringify(value)}`;
  const re = new RegExp(`^${key}:.*$`, "m");
  if (re.test(yaml)) return yaml.replace(re, line);
  return `${line}\n${yaml.trimStart()}`;
}

function coerceInputValue(value: string, type?: string): unknown {
  const kind = (type ?? "string").toLowerCase();
  if (kind === "number" || kind === "integer") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (kind === "boolean") return value === "true";
  return value;
}

function Loading() {
  return <LoadingState rows={4} />;
}

function DetailError() {
  return (
    <div style={{ color: "var(--muted-foreground)", padding: "14px 0" }}>
      Could not load details. Check your connection and try again.
    </div>
  );
}

function friendlyToken(value?: string | null): string {
  const raw = value?.trim();
  if (!raw) return "Not set";
  if (raw === "cron") return "Schedule";
  if (raw === "composio") return "Connection event";
  return raw
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function ConfigInfoGrid({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <div className="grid grid-cols-[minmax(96px,140px)_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-[var(--radius-card)] bg-[var(--bg-2)] px-4 py-3 text-sm">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <span className="text-[12.5px] text-muted-foreground">{key}</span>
          <span className="min-w-0 break-words text-foreground">{value}</span>
        </div>
      ))}
    </div>
  );
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
      {/* #1290: "Latest output" removed — its purpose was unclear to operators
          (Federico: "why is latest output shown?") and it only showed run status +
          ID with no actual output text. The History tab shows the run list. */}
      <div>
        <h4 style={h4}>WHAT IT DOES</h4>
        <AboutBody w={w} d={d} />
      </div>
    </div>
  );
}

/** One file-type chip for a brain context folder. Reuses the shared icon mapping. */
function BrainContextChip({ name }: { name: string }) {
  const meta = BRAIN_FILE_META[inferBrainFileType(name)];
  const Icon = meta.Icon;
  return (
    <span
      className="inline-flex h-7 items-center gap-1.5 rounded-[9px] px-1.5 pr-2 text-[12px] [border:var(--bd-card)]"
      style={{ background: "var(--bg-2)" }}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px]"
        style={{
          background: `color-mix(in srgb, ${meta.tint} 12%, transparent)`,
          color: meta.tint,
        }}
      >
        <Icon className="h-3 w-3" strokeWidth={2} />
      </span>
      <span className="max-w-[120px] truncate font-medium" style={{ color: "var(--ink)" }}>{name}</span>
    </span>
  );
}

function AboutBody({ w, d }: { w: WorkerSummary; d?: WorkerDetail }) {
  const description = displayBrandCopy(w.long_description || w.description) || "No description yet.";
  const contexts = d?.config?.contexts ?? [];
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
      <p style={{ margin: 0 }}>{description}</p>
      {contexts.length > 0 && (
        <div>
          <h4 style={h4}>
            <Brain className="inline-block size-[11px] align-[-1px] mr-1" aria-hidden="true" />
            Company brain it uses
          </h4>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {contexts.map((spec) => {
              const name = contextSpecName(spec);
              return <BrainContextChip key={name} name={name} />;
            })}
          </div>
        </div>
      )}
      {d?.use_cases && d.use_cases.length > 0 && (
        <div>
          <h4 style={h4}>Use cases</h4>
          <ul style={{ margin: 0, paddingLeft: 18, color: "var(--ink-soft)" }}>
            {d.use_cases.map((u, i) => (
              <li key={i}>{displayBrandCopy(u)}</li>
            ))}
          </ul>
        </div>
      )}
      {d?.how_it_works && (
        <div>
          <h4 style={h4}>How it works</h4>
          <p style={{ margin: 0, color: "var(--ink-soft)" }}>{displayBrandCopy(d.how_it_works)}</p>
        </div>
      )}
    </div>
  );
}


// Runs: recent runs w/ durations, link to the full Runs surface.
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
  const [d, applyDetail] = useWorkerDetail(w.id);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  // #1249: store both version files AND current files so the modal can show a
  // proper line-level diff (VersionDiffPanel) instead of a raw file view.
  const [diff, setDiff] = useState<{
    id: string;
    versionFiles: { path: string; content: string }[];
    currentFiles: { path: string; content: string }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());
  const editable = can("edit", w);

  useEffect(() => {
    let alive = true;
    api.workers
      .listVersions(w.id)
      .then((v) => alive && setVersions(v))
      .catch(() => alive && setVersions([]));
    // Safety timeout: stop the skeleton after 10 s if the API proxy hangs.
    const timeout = setTimeout(() => {
      if (alive) setVersions((prev) => prev ?? []);
    }, 10_000);
    return () => {
      alive = false;
      clearTimeout(timeout);
    };
  }, [w.id]);

  if (versions === null) return <Loading />;
  if (versions.length === 0) return <div style={muted}>No version history yet.</div>;
  const rows = formatVersionRows(versions, now);

  const showDiff = async (id: string) => {
    try {
      const v = await api.workers.getVersion(w.id, id);
      // Current files: prefer already-loaded detail; fall back to fetching the
      // worker detail on demand (the cache will pick it up on the next render).
      const currentFilesRaw =
        d?.files
          ?.filter((f) => !f.binary && f.content != null)
          .map((f) => ({ path: f.path, content: f.content as string })) ??
        [];
      setDiff({
        id,
        versionFiles: (v.files ?? []).map((f) => ({ path: f.path, content: f.content })),
        currentFiles: currentFilesRaw,
      });
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
      {/* #1249: replaced CodeBlock (read-only full-file view) with VersionDiffPanel
          which shows a proper line-level diff between this version and current. */}
      <Dialog open={!!diff} onOpenChange={(o) => !o && setDiff(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto p-0">
          <DialogHeader className="px-6 pt-5 pb-3">
            <DialogTitle>Version {diff?.id.slice(0, 7)}</DialogTitle>
          </DialogHeader>
          {diff && (
            <VersionDiffPanel
              versionSha={diff.id.slice(0, 7)}
              versionFiles={diff.versionFiles}
              currentFiles={diff.currentFiles}
              isRestoring={busy}
              canRestore={editable && rows.find((r) => r.id === diff.id && !r.isCurrent) !== undefined}
              onRestore={() => void restore(diff.id).then(() => setDiff(null))}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function sourceFileName(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

type SourceEditorFile = {
  path: string;
  content: string;
  binary?: boolean;
  language?: string;
  size?: number;
};

function sourceEditorFiles(files: WorkerFile[]): SourceEditorFile[] {
  return files.map((f) => ({
    path: f.path,
    content: f.content ?? "",
    binary: f.binary,
    language: f.language,
    size: f.size,
  }));
}

function SourceFileTabs({
  files,
  activePath,
  onSelect,
}: {
  files: WorkerFile[];
  activePath: string;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="c-dtabs c-source-file-tabs -mx-1 mb-3 px-1" role="tablist" aria-label="Source files">
      {files.map((file) => (
        <button
          key={file.path}
          type="button"
          role="tab"
          aria-selected={file.path === activePath}
          className={`c-dtab ${file.path === activePath ? "on" : ""}`}
          title={file.path}
          onClick={() => onSelect(file.path)}
        >
          <FileText className="size-3.5 shrink-0" />
          <span className="font-mono text-xs">{sourceFileName(file.path)}</span>
        </button>
      ))}
    </div>
  );
}

function SourceTab({ w }: { w: WorkerSummary }) {
  const [d, applyDetail] = useWorkerDetail(w.id);
  const [active, setActive] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [draftFiles, setDraftFiles] = useState<SourceEditorFile[]>([]);
  const [draftPath, setDraftPath] = useState<string>("worker.yml");
  const [saving, setSaving] = useState(false);
  if (d === undefined) return <Loading />;
  if (d === null) return <DetailError />;
  const ordered = orderedSourceFiles(d.files ?? []);
  if (ordered.length === 0) return <div style={muted}>No source files.</div>;
  const file = ordered.find((f) => f.path === active) ?? ordered[0];
  const editable = can("edit", d);

  function openEditor() {
    setDraftFiles(sourceEditorFiles(ordered));
    setDraftPath(file.path);
    setEditOpen(true);
  }

  async function saveFiles() {
    if (!d || saving) return;
    setSaving(true);
    try {
      const updated = await api.workers.updateFiles(
        d.id,
        draftFiles.map((f) => ({ path: f.path, content: f.content ?? "" })),
      );
      applyDetail(updated);
      setActive(draftPath);
      setEditOpen(false);
      toast.success("Source updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update source files.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="min-w-0">
        <div className="mb-2 flex min-w-0 items-center gap-3">
          <SourceFileTabs files={ordered} activePath={file.path} onSelect={setActive} />
          {editable && (
            <button type="button" className="c-vpill mb-3 shrink-0" style={pillBtn} onClick={openEditor}>
              Edit
            </button>
          )}
        </div>
        <CodeBlock text={file.content ?? ""} filePath={file.path} language={file.language} />
      </div>
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[90vh] sm:max-w-6xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit source</DialogTitle>
            <DialogDescription>Update this worker&apos;s source files.</DialogDescription>
          </DialogHeader>
          <FilesEditor
            mode="edit"
            files={draftFiles}
            selectedPath={draftPath}
            onChange={setDraftFiles}
            onSelectedPathChange={setDraftPath}
          />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void saveFiles()} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function BrainTab({ w }: { w: WorkerSummary }) {
  const [d, applyDetail] = useWorkerDetail(w.id);
  const [packs, setPacks] = useState<{ name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const refreshPacks = useCallback(() => {
    api.contexts.list().then(setPacks).catch(() => {});
  }, []);
  useEffect(() => {
    refreshPacks();
  }, [refreshPacks]);
  if (d === undefined) return <Loading />;
  if (d === null) return <DetailError />;
  const editable = can("edit", d);
  const contexts = d.config?.contexts ?? [];
  // Per-worker memory folder convention: "<worker-id>-memory". Connecting it
  // gives the worker a writeable folder it owns by default (issue 6b).
  const memoryFolderName = `${w.id}-memory`;
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
  const attachMemory = async () => {
    setBusy(true);
    try {
      // Create the writeable memory folder if it does not exist yet (idempotent:
      // a 409/duplicate just means it is already there).
      if (!packs.some((p) => p.name === memoryFolderName)) {
        try {
          await api.contexts.create(memoryFolderName, true);
        } catch {
          // Folder may already exist (created by a prior run); continue to attach.
        }
        refreshPacks();
      }
      const attached = setContextWriteable(toggleContext(contexts, memoryFolderName), memoryFolderName, true);
      applyDetail(await persistYml(d, patchBrainContexts(workerYml(d), attached)));
      toast.success("Memory folder connected");
    } catch {
      toast.error("Could not connect the memory folder.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <WorkerBrainEditor
      contexts={contexts}
      availablePacks={packs}
      editable={editable}
      busy={busy}
      onChange={(next) => void save(next)}
      memoryFolderName={memoryFolderName}
      onAttachMemory={attachMemory}
    />
  );
}

function ToolsTab({ w }: { w: WorkerSummary }) {
  const [d, applyDetail] = useWorkerDetail(w.id);
  const [busy, setBusy] = useState(false);
  if (d === undefined) return <Loading />;
  if (d === null) return <DetailError />;
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

/** Read the worker's current triggers (multi-trigger spec first, single fallback). */
function currentTriggerRows(d: WorkerDetail): TriggerRow[] {
  const specs: TriggerSpec[] =
    d.triggers_spec && d.triggers_spec.length > 0
      ? d.triggers_spec
      : d.config?.trigger
        ? [d.config.trigger as TriggerSpec]
        : [];
  return specs.map((s) => makeTriggerRow(s));
}

// W-02: Triggers are EDITABLE — read the current trigger(s) from worker.yml and
// let the owner change the schedule / webhook / app-event / manual via the same
// TriggersEditor used in the create flow. Persists through the worker.yml PUT
// (replaceTriggerBlock → updateFiles), the path Tools/Brain already use.
function TriggersTab({ w }: { w: WorkerSummary }) {
  const [d, applyDetail] = useWorkerDetail(w.id);
  const [rows, setRows] = useState<TriggerRow[] | null>(null);
  const [saving, setSaving] = useState(false);

  // Initialize editor rows from the loaded detail (once it arrives).
  useEffect(() => {
    if (d && rows === null) setRows(currentTriggerRows(d));
  }, [d, rows]);

  if (d === undefined || rows === null) return <Loading />;
  if (d === null) return <DetailError />;
  const editable = can("edit", d);
  const baseline = JSON.stringify(currentTriggerRows(d).map(stripRowId));
  const dirty = JSON.stringify(rows.map(stripRowId)) !== baseline;

  // Read-only view: list the configured trigger(s) without editing chrome.
  if (!editable) {
    return (
      <div className="flex flex-col gap-4">
        <ConfigInfoGrid
          rows={[
            ["Trigger", friendlyToken(d.config?.trigger?.type ?? w.trigger_type)],
            ...(d.config?.trigger?.cron
              ? [["Schedule", d.config.trigger.cron] as [string, React.ReactNode]]
              : []),
            ...(d.config?.trigger?.timezone
              ? [["Timezone", d.config.trigger.timezone] as [string, React.ReactNode]]
              : []),
            ...(d.webhook_url
              ? [["Webhook", <span key="webhook" className="font-mono text-xs">{d.webhook_url}</span>] as [string, React.ReactNode]]
              : []),
          ]}
        />
      </div>
    );
  }

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const yaml = replaceTriggerBlock(workerYml(d), buildTriggersYaml(rows));
      const updated = await persistYml(d, yaml);
      applyDetail(updated);
      setRows(currentTriggerRows(updated));
      toast.success("Triggers updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update triggers.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <TriggersEditor
      rows={rows}
      onChange={setRows}
      webhookUrl={d.webhook_url}
      dirty={dirty}
      saving={saving}
      onSave={() => void save()}
      onDiscard={() => setRows(currentTriggerRows(d))}
    />
  );
}

/** Compare trigger rows ignoring the random client-only `id`. */
function stripRowId(row: TriggerRow): Omit<TriggerRow, "id"> {
  const { id: _id, ...rest } = row;
  void _id;
  return rest;
}

// Config: Tools · Brain attach · Triggers · runtime in one scroll.
// ("paused" = enabled:false — there is no paused status; pause/resume is #788;
// spend cap is #793; PATCH name/desc is #785; brain attach/detach is #790 —
// today these route through the full worker-YAML PUT.)
function ConfigTab({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
  // #1279: distinguish loading (undefined) from load-failure (null) so a hung
  // API surfaces an error instead of an infinite skeleton.
  if (d === undefined) return <Loading />;
  if (d === null) return <DetailError />;
  const runtime = d.config?.runtime;
  const modelId = runtime?.model ?? d.config?.model;
  const runtimeLine = [
    d.enabled === false ? "Paused" : "Enabled",
    runtimeSummary({
      runner: runtime?.runner ?? d.runner ?? w.runner,
      runtime: runtime?.type ?? w.runtime,
    }),
    runtime?.mode ? friendlyToken(runtime.mode) : null,
    runtime?.entrypoint ? `Entry ${runtime.entrypoint}` : null,
    modelId ? modelLabel(modelId) : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-7">
      <p className="m-0 text-[12.5px] text-muted-foreground">{runtimeLine}</p>
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
        {/* W-02: editable trigger control (schedule / webhook / app-event / manual). */}
        <TriggersTab w={w} />
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
  Runs: RunsTab,
  Config: ConfigTab,
  Source: SourceTab,
  Versions: VersionsTab,
};

function WorkerDetailActions({
  w,
  onUpdated,
  canManage = false,
}: {
  w: WorkerSummary;
  onUpdated: (w: WorkerSummary) => void;
  canManage?: boolean;
}) {
  const router = useRouter();
  const [d, applyDetail] = useWorkerDetail(w.id);
  const [runOpen, setRunOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  const [name, setName] = useState(w.name);
  const [description, setDescription] = useState(w.description ?? "");

  const inputs = d?.config?.inputs ?? w.inputs ?? [];

  useEffect(() => {
    if (!runOpen) return;
    const next: Record<string, string> = {};
    for (const input of inputs) {
      const fallback = input.default == null ? "" : String(input.default);
      next[input.name] = runInputs[input.name] ?? fallback;
    }
    setRunInputs(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runOpen, d?.id]);

  useEffect(() => {
    if (!editOpen) return;
    setName(d?.name ?? w.name);
    setDescription(d?.description ?? w.description ?? "");
  }, [editOpen, d?.description, d?.name, w.description, w.name]);

  async function submitRun(event: React.FormEvent) {
    event.preventDefault();
    if (running) return;
    setRunning(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const input of inputs) {
        const raw = runInputs[input.name] ?? "";
        if (raw !== "") payload[input.name] = coerceInputValue(raw, input.type);
      }
      const result = await api.workers.run(w.id, payload);
      toast.success("Run queued");
      setRunOpen(false);
      if (result.run_id) router.push(`/runs?sel=${encodeURIComponent(result.run_id)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run worker");
    } finally {
      setRunning(false);
    }
  }

  async function submitEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!d || saving) return;
    const nextName = name.trim();
    const nextDescription = description.trim();
    if (!nextName) {
      toast.error("Worker name is required.");
      return;
    }
    setSaving(true);
    try {
      let yaml = workerYml(d);
      yaml = patchTopLevelScalar(yaml, "name", nextName);
      yaml = patchTopLevelScalar(yaml, "description", nextDescription);
      const updated = await persistYml(d, yaml);
      applyDetail(updated);
      onUpdated({ ...w, name: updated.name, description: updated.description });
      toast.success("Worker updated");
      setEditOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update worker");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {(canManage || can("run", w)) && (
        <button
          type="button"
          className="c-addbtn"
          style={pillBtn}
          onClick={() => setRunOpen(true)}
          title={w.enabled === false || (w as WorkerSummary & { paused?: boolean }).paused ? "This worker is paused; it may not run as expected" : undefined}
        >
          Run
        </button>
      )}
      {(canManage || can("edit", w)) && (
        <DropdownMenu>
          <DropdownMenuTrigger className="c-vpill" style={pillBtn} aria-label="More worker actions">
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44 p-1">
            <DropdownMenuItem onClick={() => setEditOpen(true)}>Edit</DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const isArchived = (w as WorkerSummary & { archived?: boolean }).archived;
                const action = isArchived ? api.workers.restore : api.workers.archive;
                action(w.id)
                  .then(() => {
                    toast.success(isArchived ? "Worker restored" : "Worker archived");
                    onUpdated({ ...w });
                  })
                  .catch((err: Error) => toast.error(err.message || "Could not update worker"));
              }}
            >
              {(w as WorkerSummary & { archived?: boolean }).archived ? "Restore" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => {
                if (!window.confirm(`Delete "${w.name}"? This cannot be undone.`)) return;
                api.workers.delete(w.id)
                  .then(() => {
                    toast.success("Worker deleted");
                    onUpdated({ ...w, _deleted: true } as WorkerSummary & { _deleted?: boolean });
                  })
                  .catch((err: Error) => toast.error(err.message || "Could not delete worker"));
              }}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={(event) => void submitRun(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Run {w.name}</DialogTitle>
              <DialogDescription>Provide inputs for this manual run.</DialogDescription>
            </DialogHeader>
            {w.enabled === false && (
              <div className="rounded-[var(--radius-card)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-3 py-2 text-sm text-[var(--warning)]">
                This worker is paused. Running it manually may not behave as expected.
              </div>
            )}
            <div className="space-y-3">
              {inputs.length === 0 ? (
                <p className="rounded-[var(--radius-card)] bg-[var(--bg-2)] p-3 text-sm text-muted-foreground">
                  This worker has no required inputs.
                </p>
              ) : (
                inputs.map((input) => (
                  <div key={input.name} className="space-y-1.5">
                    <Label htmlFor={`run-${w.id}-${input.name}`}>{input.label || input.name}</Label>
                    {isStructuredInput(input) ? (
                      <StructuredInputField
                        input={input}
                        workerId={w.id}
                        value={runInputs[input.name] ?? ""}
                        onChange={(v) => setRunInputs((prev) => ({ ...prev, [input.name]: v }))}
                      />
                    ) : (
                      <>
                        <Input
                          id={`run-${w.id}-${input.name}`}
                          value={runInputs[input.name] ?? ""}
                          placeholder={input.placeholder || input.description || input.name}
                          onChange={(event) =>
                            setRunInputs((prev) => ({ ...prev, [input.name]: event.target.value }))
                          }
                        />
                        {input.description ? (
                          <p className="text-xs text-muted-foreground">{input.description}</p>
                        ) : null}
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setRunOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={running}>
                {running ? "Running..." : "Run"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={(event) => void submitEdit(event)} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Edit worker</DialogTitle>
              <DialogDescription>Update the worker identity without leaving the split detail.</DialogDescription>
            </DialogHeader>
            {d === undefined ? (
              <Loading />
            ) : d === null ? (
              <DetailError />
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`edit-${w.id}-name`}>Name</Label>
                  <Input
                    id={`edit-${w.id}-name`}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`edit-${w.id}-description`}>Description</Label>
                  <Textarea
                    id={`edit-${w.id}-description`}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    className="min-h-24"
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!d || saving}>
                {saving ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---- #1092: Workers empty-state inline prompt --------------------------------

/**
 * A compact prompt input shown in the workers empty state so users can
 * describe what they want done and jump straight into the Emily create flow.
 */
function WorkersEmptyPrompt({ onSubmit }: { onSubmit: (prompt: string) => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 flex items-center gap-2 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-2)] px-3 py-2"
      style={{ maxWidth: 380 }}
    >
      <input
        ref={inputRef}
        type="text"
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        placeholder="Describe the job you want done…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoComplete="off"
      />
      <button
        type="submit"
        disabled={!value.trim()}
        className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent)] text-[var(--accent-foreground)] opacity-90 hover:opacity-100 disabled:opacity-30 transition-opacity"
        aria-label="Create worker"
      >
        <ArrowRight className="size-3.5" />
      </button>
    </form>
  );
}

// ---- #1090: Friendly structured-input field for the manual-run modal ----------

/** Returns true when the input type signals a JSON/CSV/structured payload. */
function isStructuredInput(input: WorkerInput): boolean {
  const t = (input.type ?? "").toLowerCase();
  return (
    t === "array" ||
    t === "object" ||
    t === "json" ||
    t === "csv" ||
    !!input.accept_csv
  );
}

/**
 * A friendlier replacement for a raw textarea for structured/JSON inputs.
 * Shows:
 *  - A file upload button (CSV or JSON)
 *  - A "Load example" button (calls sampleInput API)
 *  - A collapsible "Format" details block for the schema hint
 *  - A fallback textarea for manual paste
 */
function StructuredInputField({
  input,
  workerId,
  value,
  onChange,
}: {
  input: WorkerInput;
  workerId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showFormat, setShowFormat] = useState(false);

  const acceptAttr = input.accept_csv ? ".csv,.json" : ".json";
  const label = input.label || input.name;

  async function loadExample() {
    setLoading(true);
    try {
      const sample = await api.workers.sampleInput(workerId);
      const raw = sample[input.name];
      if (raw !== undefined) {
        onChange(typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
        setFileName(null);
      } else {
        toast("No example available for this input.");
      }
    } catch {
      toast.error("Could not load example.");
    } finally {
      setLoading(false);
    }
  }

  function handleFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      onChange(text ?? "");
    };
    reader.readAsText(file);
  }

  // Schema hint: description or placeholder from the input spec.
  const hint = input.description || input.placeholder || null;

  return (
    <div className="space-y-2">
      {/* Upload + Load example toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-2)] px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <UploadCloud className="size-3.5" />
          {fileName ?? `Upload ${acceptAttr}`}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={acceptAttr}
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <button
          type="button"
          disabled={loading}
          onClick={() => void loadExample()}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-2)] px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load example"}
        </button>
        {hint && (
          <button
            type="button"
            onClick={() => setShowFormat((v) => !v)}
            className="inline-flex items-center gap-1 ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Format {showFormat ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        )}
      </div>

      {/* Collapsible format/schema hint */}
      {showFormat && hint && (
        <p className="rounded-[var(--radius-card)] bg-[var(--bg-2)] px-3 py-2 text-xs text-muted-foreground">
          {hint}
        </p>
      )}

      {/* Paste textarea */}
      <Textarea
        id={`run-${workerId}-${input.name}`}
        value={value}
        placeholder={
          input.accept_csv
            ? `Paste CSV or JSON, or upload a file above…`
            : `Paste JSON${hint ? ` (see Format for the schema)` : ""}…`
        }
        onChange={(e) => onChange(e.target.value)}
        className="min-h-24 font-mono text-xs"
      />
      {label && input.required && (
        <p className="text-[11px] text-muted-foreground">Required · {label}</p>
      )}
    </div>
  );
}

/**
 * A host-injected top-level view (#1006). workeros-cloud passes its
 * cross-tenant "workspace-admin" view here so it can compose the engine
 * `WorkersCollection` instead of forking the whole 869-line component. The
 * host decides visibility (e.g. only pass it when `api.me().is_admin`); the
 * engine stays generic and renders the switcher only when views are supplied.
 */
export type WorkersExtraView = {
  /** Stable key, also the active-view id. */
  key: string;
  /** Label shown in the top-of-collection view switcher. */
  label: string;
  /** Rendered in place of the workers Collection when this view is active. */
  render: () => React.ReactNode;
};

const WORKERS_VIEW_KEY = "workers";

export default function WorkersCollection({
  initialWorkers,
  extraViews = [],
}: {
  initialWorkers: WorkerSummary[];
  extraViews?: WorkersExtraView[];
}) {
  const router = useRouter();
  const [workers, setWorkers] = useState<WorkerSummary[]>(initialWorkers);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(initialWorkers.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [canManageWorkers, setCanManageWorkers] = useState(false);
  const [activeView, setActiveView] = useState<string>(WORKERS_VIEW_KEY);

  useEffect(() => {
    let alive = true;
    setFavorites(getFavorites());
    const meRequest = typeof api.me === "function" ? api.me() : Promise.resolve(null);
    meRequest
      .then((user) => {
        if (alive) {
          setCanManageWorkers(
            user?.is_admin ?? (user?.role === "admin" || user?.role === "owner"),
          );
        }
      })
      .catch(() => {});
    api.workers
      .list({ include_archived: true })
      .then((all) => {
        if (alive) setWorkers(all.filter((w) => !isSystemWorker(w)));
      })
      .catch(() => {
        if (alive) setError("Could not load workers. Check your connection and try again.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    // Safety timeout: if the API proxy is unreachable and the request hangs,
    // stop showing the skeleton after 10 s so users see an error + retry.
    const timeout = setTimeout(() => {
      if (alive) {
        setLoading(false);
        setError("Could not load workers. Check your connection and try again.");
      }
    }, 10_000);
    return () => {
      alive = false;
      clearTimeout(timeout);
    };
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
    loading,
    error,
    idOf: (w) => w.id,
    searchPlaceholder: "Search workers or tags…",
    searchOf: (w) => `${w.name} ${displayBrandCopy(w.description)} ${(w.tags ?? []).join(" ")}`,
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
      template: "1.9fr 1fr 1fr 130px 40px", // #895: wireframe pageWorkers grid
      headers: ["Worker", "Tools", "Last run", "Status", ""],
    },
    row: (w) => ({
      // V4 SPEC rule 3: no avatar for workers.
      // Lock icon: inline after title at baseline (small + muted), never as leading.
      leading: undefined,
      primary: w.visibility === "private"
        ? <span className="inline-flex items-center gap-1.5">{w.name}<Lock className="size-3 shrink-0 text-[var(--muted-foreground)]" /></span>
        : w.name,
      secondary: displayBrandCopy(w.description),
      cols: [
        <WorkerIconPills key="t" worker={{ id: w.id, name: w.name, connections: w.connections }} max={3} />,
        rel(w.recent_stats?.last_run_at),
      ],
      status: workerStatusPill(w),
      menu: [{ label: "Open", onSelect: () => router.push(`/workers?sel=${encodeURIComponent(w.id)}`) }],
    }),
    card: (w) => {
      const meta = workerCardMeta(w);
      return {
        // V4 SPEC rule 3: no avatar monogram. Lock is small+muted inline after name.
        leading: undefined,
        name: w.visibility === "private"
          ? <span className="inline-flex min-w-0 items-center gap-1.5"><span className="truncate">{w.name}</span><Lock className="size-3 shrink-0 text-[var(--muted-foreground)]" /></span>
          : w.name,
        description: displayBrandCopy(w.description),
        // B17: muted telemetry (last-run · run count · success rate) from recent_stats.
        meta: meta ?? undefined,
        status: workerStatusPill(w),
        toolLogos: <WorkerIconPills worker={{ id: w.id, name: w.name, connections: w.connections }} max={3} />,
        star: { on: favorites.has(w.id), onToggle: () => toggleStar(w.id) },
        // #1117: mini run-history sparkline (hover only). Uses timeseries if the
        // API returned it; falls back to undefined (sparkline hidden) if absent.
        sparkline: w.timeseries && w.timeseries.length > 0
          ? <Sparkline data={w.timeseries} width={56} height={22} tone="status" variant="bars" />
          : undefined,
        // #1308: removed View (redundant — clicking the card opens it) and
        // Edit (opens the same split-pane; Config tab is one click away).
        quickActions: [],
      };
    },
    detail: (w) => {
      const viewOnly = !canManageWorkers && isViewOnly(w);
      const actions = (
        <WorkerDetailActions
          w={w}
          canManage={canManageWorkers}
          onUpdated={(updated) => {
            if ((updated as WorkerSummary & { _deleted?: boolean })._deleted) {
              setWorkers((prev) => prev.filter((item) => item.id !== updated.id));
            } else {
              setWorkers((prev) => prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
            }
          }}
        />
      );
      return {
        header: {
          // V4 SPEC rule 3: no avatar monogram in detail header. Lock inline after title.
          leading: undefined,
          title: w.visibility === "private"
            ? <span className="inline-flex min-w-0 items-center gap-1.5"><span className="truncate">{w.name}</span><Lock className="size-3.5 shrink-0 text-[var(--muted-foreground)]" /></span>
            : w.name,
          actions,
          sub: (
            <>
              <span className="c-vpill">{visibilityLabel(w.visibility)}</span>
              {viewOnly && (
                <span className="c-vpill" style={{ color: "var(--warning)", borderColor: "var(--warning)" }}>
                  View only
                </span>
              )}
              <span className="c-dh-desc">
                {displayBrandCopy(w.description)}
              </span>
            </>
          ),
        },
        // SPEC §4: tabs are DERIVED from WORKER_DETAIL_TABS so the contract test
        // guards what actually renders (no drift between constant and component).
        tabs: WORKER_DETAIL_TABS.map((key) => {
          const Tab = WORKER_TAB_COMPONENT[key];
          return {
            key,
            label: key,
            // #1251: badge must match the count actually listed in the Runs tab,
            // which renders d?.recent_runs (the capped list from WorkerDetail).
            // Use cached recent_runs length when available; otherwise fall back to
            // last_run presence so the badge shows something before detail loads.
            // Avoids the mismatch where runs_7d (7-day total) differed from the list.
            count: key === "Runs"
              ? (detailCache.get(w.id)?.recent_runs?.length
                  ?? (w.last_run ? 1 : undefined))
              : undefined,
            render: () => <Tab w={w} />,
          };
        }),
      };
    },
    // Contextual toolbar action only; the global sidebar CTA was removed for v4.
    add: { label: "Add", onSelect: () => router.push("/chat?mode=create") }, // #902: create = Emily flow
    states: {
      // #1364 — improved help text + action CTA linking to /workers/new
      empty: {
        title: "No workers yet",
        help: "Workers are AI agents that run on a schedule, webhook, or on demand — powered by your connected apps.",
        action: (
          <WorkersEmptyPrompt
            onSubmit={(prompt) => router.push(`/chat?mode=create&q=${encodeURIComponent(prompt)}`)}
          />
        ),
      },
      errorRetry: () => {
        setError(null);
        setLoading(true);
        api.workers
          .list({ include_archived: true })
          .then((all) => setWorkers(all.filter((w) => !isSystemWorker(w))))
          .catch(() => setError("Could not load workers. Check your connection and try again."))
          .finally(() => setLoading(false));
      },
    },
  };

  // OSS path: no host views -> render the Collection exactly as before.
  if (extraViews.length === 0) {
    return <Collection config={config} />;
  }

  // Host path (cloud): a top-level switcher between the workers Collection and
  // each injected view. Reuses the app's tab styling (c-dtabs / c-dtab).
  // The "Workers" tab label already names this view, so we suppress the
  // Collection's own "Workers" H1 header to avoid the duplicated heading.
  const tabSwitcherConfig = { ...config, hideTitle: true };
  const activeExtra = extraViews.find((v) => v.key === activeView);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="c-dtabs px-4 pt-3" role="tablist" aria-label="Workers views">
        <button
          type="button"
          role="tab"
          aria-selected={activeView === WORKERS_VIEW_KEY}
          className={`c-dtab ${activeView === WORKERS_VIEW_KEY ? "on" : ""}`}
          onClick={() => setActiveView(WORKERS_VIEW_KEY)}
        >
          Workers
        </button>
        {extraViews.map((v) => (
          <button
            type="button"
            role="tab"
            key={v.key}
            aria-selected={activeView === v.key}
            className={`c-dtab ${activeView === v.key ? "on" : ""}`}
            onClick={() => setActiveView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {activeExtra ? activeExtra.render() : <Collection config={tabSwitcherConfig} />}
      </div>
    </div>
  );
}

const muted: React.CSSProperties = { color: "var(--muted-foreground)" };
const h4: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: ".05em",
  textTransform: "uppercase",
  color: "var(--muted-foreground)",
  margin: "0 0 9px",
};
const pillBtn: React.CSSProperties = { padding: "6px 11px", fontSize: 12.5 };
