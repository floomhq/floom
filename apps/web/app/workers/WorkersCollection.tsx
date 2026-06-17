"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useWorkers } from "@/lib/query/hooks";
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
import {
  WORKER_DETAIL_TABS,
  type WorkerDetailTab,
  OPERATIONS_SUBTABS,
  type OperationsSubtab,
} from "@/lib/workers/tabs";
import { formatDuration } from "@/lib/runs/format";
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
import { ArrowRight, Brain, Lock, MoreHorizontal, Plus } from "lucide-react";
import { BRAIN_FILE_META, inferBrainFileType } from "@/lib/brain/file-type-icon";
import { WorkerIconPills } from "@/components/WorkerIconPills";
import { Sparkline } from "@/components/Sparkline";
import { WorkerAsciiDiagram } from "@/components/WorkerAsciiDiagram";
import {
  FilesEditor,
  TriggersEditor,
  makeTriggerRow,
  buildTriggersYaml,
  replaceTriggerBlock,
  type TriggerRow,
} from "@/components/worker-form";
import { WorkerInputForm, requiredRunInputErrors } from "@/components/run-page/WorkerInputForm";
import { ShareModal } from "@/components/sharing/ShareModal";
import { WorkerBrainEditor } from "@/components/worker/WorkerBrainEditor";
import { WorkerToolsEditor } from "@/components/worker/WorkerToolsEditor";
import { WorkerFeedbackPanel } from "@/components/worker/WorkerFeedbackPanel";
import { VersionDiffPanel } from "@/components/VersionDiffPanel";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  workerStageKey,
  workerTags,
  contentTagOptions,
  orderedSourceFiles,
} from "@/lib/workers/derive";
import { getFavorites, saveFavorites } from "@/lib/workers/favorites";
import {
  ADVANCED_DETAIL_TABS,
  BASE_DETAIL_TABS,
  getPinnedTabs,
  savePinnedTabs,
} from "@/lib/workers/pinned-tabs";
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
    // Retry once before surfacing an error — a transiently slow backend should
    // not strand the detail tabs on "Could not load" (#1279 + round-03 source-load).
    const load = (attempt: number) => {
      api.workers
        .get(id)
        .then((d) => {
          detailCache.set(id, d);
          if (alive) setDetail(d);
        })
        .catch(() => {
          if (!alive) return;
          if (attempt < 1) setTimeout(() => load(attempt + 1), 1500);
          else setDetail(null); // null = failed to load → tabs show error, not a spinner
        });
    };
    load(0);
    // Safety timeout: if the API proxy hangs entirely, surface an error after 25 s
    // (long enough to cover the retry above).
    const timeout = setTimeout(() => {
      if (alive && detail === undefined) setDetail(null);
    }, 25_000);
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

/**
 * Project a fetched WorkerDetail into the WorkerSummary shape the list/cards
 * need. Used when a deep-link / "Open worker" points at a worker that isn't in
 * the (cache-first, 30s-stale) workers list yet, e.g. a worker Emily just
 * created. We fetch it by id and merge a summary so the selection resolves
 * instead of falsely toasting "Item not found … old ID format".
 */
function detailToSummary(d: WorkerDetail): WorkerSummary {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    long_description: d.long_description,
    use_cases: d.use_cases,
    example_input: d.example_input,
    example_output: d.example_output,
    how_it_works: d.how_it_works,
    is_example: d.is_example,
    archived: d.archived,
    enabled: d.enabled,
    archive_reason: d.archive_reason,
    stage: d.stage,
    tags: d.tags ?? [],
    folder: d.folder,
    status: d.status,
    trigger_type: d.trigger_type,
    runner: d.runner,
    triggers: [],
    triggers_spec: d.triggers_spec ?? [],
    // Summary `connections` is the list of app slugs; derive from the config.
    connections: (d.config?.connections ?? [])
      .map((c) => (typeof c === "string" ? c : (c as { app?: string }).app))
      .filter((s): s is string => Boolean(s)),
    missing_secrets: d.missing_secrets,
    missing_connections: d.missing_connections,
    inputs: d.config?.inputs,
    public_link: d.public_link,
    owner_id: d.owner_id,
    visibility: d.visibility,
    permissions: d.permissions,
  } as WorkerSummary;
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

/** Patch a top-level scalar with a RAW (unquoted) value — for YAML booleans/
 *  numbers where quoting would change the type (e.g. `enabled: false`). */
function patchTopLevelRaw(yaml: string, key: string, raw: string): string {
  const line = `${key}: ${raw}`;
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
        {/* #1279: useWorkerDetail can now return null (load failed); the overview
            treats that the same as "not loaded yet" — AboutBody renders its empty state. */}
        <AboutBody w={w} d={d ?? undefined} />
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

// §3.2/§3.3/§3.4 — Source tab: two-pane file-rail viewer (FilesEditor view mode)
// with an "Edit source" button that opens FilesEditor in edit mode.
// On Save: calls api.workers.updateFiles (PUT /workers/{id}/files).
// Protected workers that clone on edit return a new WorkerDetail — applyDetail handles it.
function SourceTab({ w }: { w: WorkerSummary }) {
  const [d, applyDetail] = useWorkerDetail(w.id);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [draftFiles, setDraftFiles] = useState<{ path: string; content: string; binary?: boolean; language?: string; size?: number }[]>([]);
  const [draftPath, setDraftPath] = useState<string>("worker.yml");
  const [saving, setSaving] = useState(false);

  if (d === undefined) return <Loading />;
  if (d === null) return <DetailError />;

  const ordered = orderedSourceFiles(d.files ?? []);
  if (ordered.length === 0) return <div style={muted}>No source files.</div>;

  const editable = can("edit", d);
  // Default selected path to first file if not yet set.
  const activePath = selectedPath ?? ordered[0]?.path ?? null;

  function openEditor() {
    setDraftFiles(
      ordered.map((f) => ({
        path: f.path,
        content: f.content ?? "",
        binary: f.binary,
        language: f.language,
        size: f.size,
      })),
    );
    setDraftPath(activePath ?? "worker.yml");
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
      setSelectedPath(draftPath);
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
      {editable && (
        <div className="mb-3 flex justify-end">
          <button type="button" className="c-vpill" style={pillBtn} onClick={openEditor}>
            Edit source
          </button>
        </div>
      )}
      {/* §3.2: full two-pane file-rail + syntax-highlighted viewer (FilesEditor view mode).
          This replaces the prior compact SourceFileTabs + CodeBlock layout. */}
      <FilesEditor
        mode="view"
        files={ordered as WorkerFile[]}
        selectedPath={activePath}
        onSelect={(path) => setSelectedPath(path)}
      />
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

// round-09: the old monolithic ConfigTab (Tools + Brain + Triggers + runtime +
// Feedback in one scroll) is dissolved into the new structure — Tools and Brain
// are Advanced tabs, Triggers + runtime/limits live under Operations. The proven
// Feedback section (backend-gated) is preserved as a reusable helper and shown in
// the Operations > Limits panel so no proven content is cut.
function WorkerFeedbackSection({ w }: { w: WorkerSummary }) {
  if (!FEEDBACK_BACKEND_AVAILABLE) return null;
  return (
    <section>
      <h4 style={h4}>Feedback</h4>
      <WorkerFeedbackPanel workerId={w.id} canLeave={canLeaveFeedback(w)} canModerate={can("edit", w)} />
    </section>
  );
}

// ---- Operations (round-09) ---------------------------------------------------
// Operations is a PRIMARY tab that hosts a SECOND ROW of tabs (no sidebar):
//   Inputs · Alerts & webhooks · Triggers · Limits
// framed as a "Visual editor of worker.yml" with a "View as YAML" deep-link into
// Source. Each panel REUSES the real editors/primitives (WorkerInputForm,
// TriggersEditor via TriggersTab, ConfigInfoGrid) — no hand-rolled chrome.

/** Persisted named input templates (per-user, per-worker, localStorage). A
 *  worker carries one declared-input schema; an operator saves multiple named
 *  value sets ("Weekly default", "Month-end close") to run from. */
type InputTemplate = { name: string; values: Record<string, unknown> };
function inputTemplatesKey(workerId: string): string {
  return `floom.workerDetail.inputTemplates.${workerId}`;
}
function loadInputTemplates(workerId: string): InputTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(inputTemplatesKey(workerId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is InputTemplate =>
        !!t && typeof (t as InputTemplate).name === "string" && typeof (t as InputTemplate).values === "object",
    );
  } catch {
    return [];
  }
}
function saveInputTemplates(workerId: string, templates: InputTemplate[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(inputTemplatesKey(workerId), JSON.stringify(templates));
  } catch {
    /* ignore quota / privacy-mode */
  }
}

// Operations > Inputs: a segmented named-template picker above the REAL
// WorkerInputForm (single source of truth, same widget the /run page uses).
function OpsInputsPanel({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
  const inputs = d?.config?.inputs ?? w.inputs ?? [];
  const [templates, setTemplates] = useState<InputTemplate[]>([]);
  const [activeIdx, setActiveIdx] = useState(0); // 0 = "Default"
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});

  useEffect(() => {
    setTemplates(loadInputTemplates(w.id));
  }, [w.id]);

  // Seed values from the active template (or schema defaults for "Default").
  useEffect(() => {
    const tmpl = activeIdx > 0 ? templates[activeIdx - 1] : undefined;
    const next: Record<string, unknown> = {};
    for (const inp of inputs) {
      next[inp.name] = tmpl?.values[inp.name] ?? (inp.default == null ? "" : inp.default);
    }
    setValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, templates, d?.id]);

  const activeName = activeIdx > 0 ? templates[activeIdx - 1]?.name : "Default";

  const saveActive = () => {
    if (activeIdx === 0) {
      const name = window.prompt("Name this input template", "Weekly default")?.trim();
      if (!name) return;
      const next = [...templates, { name, values }];
      setTemplates(next);
      saveInputTemplates(w.id, next);
      setActiveIdx(next.length);
      toast.success(`Saved template "${name}"`);
    } else {
      const next = templates.map((t, i) => (i === activeIdx - 1 ? { ...t, values } : t));
      setTemplates(next);
      saveInputTemplates(w.id, next);
      toast.success(`Updated "${activeName}"`);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Segmented named-template picker (Default + saved templates + New). */}
      <div>
        <h4 style={h4}>Input templates</h4>
        <div className="flex flex-wrap items-center gap-2">
          {["Default", ...templates.map((t) => t.name)].map((name, idx) => (
            <button
              key={`${name}-${idx}`}
              type="button"
              className="c-vpill"
              style={{
                padding: "5px 10px",
                cursor: "pointer",
                ...(idx === activeIdx
                  ? { background: "var(--bg-3)", color: "var(--ink)", fontWeight: 500 }
                  : {}),
              }}
              onClick={() => setActiveIdx(idx)}
            >
              {name}
            </button>
          ))}
          <button
            type="button"
            className="c-vpill"
            style={{ padding: "5px 10px", cursor: "pointer", color: "var(--muted-foreground)" }}
            onClick={() => setActiveIdx(0)}
            title="Start from Default, fill values, then Save as a new template"
          >
            <Plus className="size-3" aria-hidden="true" /> New template
          </button>
        </div>
      </div>

      {/* The REAL schema-driven input form (same component the run dialog uses). */}
      <WorkerInputForm
        inputs={inputs}
        values={values}
        fileNames={fileNames}
        onInputChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
        onFileUploaded={(name, sha256, fileName) => {
          setValues((prev) => ({ ...prev, [name]: sha256 }));
          setFileNames((prev) => ({ ...prev, [name]: fileName }));
        }}
      />

      {inputs.length > 0 && (
        <div className="flex items-center gap-3 pt-1">
          <span style={{ ...muted, fontSize: 12.5 }}>
            Editing {activeName ? `"${activeName}"` : "Default"}
          </span>
          <button type="button" className="c-addbtn" style={pillBtn} onClick={saveActive}>
            {activeIdx === 0 ? "Save as template" : "Save template"}
          </button>
        </div>
      )}
    </div>
  );
}

// Operations > Alerts & webhooks: split EMAIL-ON-EVENT from WEBHOOK-POST, honest
// about the backend. Per-worker alert rows (email + webhook channels) are wired;
// the workspace failure-email RECIPIENT is a confirmed silent no-op (no UI field
// to set failure_email_to) — surfaced as a neutral callout, not implied working.
function OpsAlertsPanel({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
  if (d === undefined) return <Loading />;
  if (d === null) return <DetailError />;
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h4 style={h4}>Alerts (email on event)</h4>
        <ConfigInfoGrid
          rows={[
            ["Events", "failed, completed"],
            ["Recipients", "Workspace members (validated at save)"],
            ["Channel", "Email via Resend"],
          ]}
        />
        <p style={{ ...muted, fontSize: 12.5, marginTop: 8 }}>
          Email a workspace member when this worker&apos;s run fails or completes.
        </p>
      </section>

      <section>
        <h4 style={h4}>Webhooks (POST on event)</h4>
        <ConfigInfoGrid
          rows={[
            ["Events", "failed, completed"],
            ["Signing", "X-Workeros-Signature (HMAC)"],
            ["Egress", "Internal/metadata targets blocked (SSRF-pinned)"],
            ["Current", d.webhook_url ? <span key="u" className="font-mono text-xs">{d.webhook_url}</span> : "Not set"],
          ]}
        />
        <p style={{ ...muted, fontSize: 12.5, marginTop: 8 }}>
          POST the run outcome to an external URL on the same events, signed and
          redirect-blocked.
        </p>
      </section>

      {/* Honest callout for the confirmed workspace failure-email no-op (N3). */}
      <div
        className="rounded-[var(--radius-card)] bg-[var(--bg-2)] px-4 py-3"
        style={{ fontSize: 12.5, color: "var(--ink-soft)" }}
      >
        <strong style={{ color: "var(--ink)" }}>Heads up:</strong> the workspace-level
        &quot;email me on run failures&quot; toggle sends to nobody unless a recipient is
        configured server-side (no UI field exists for it yet). Per-worker alert and
        webhook channels above are wired and do deliver.
        <div style={{ marginTop: 6, color: "var(--muted-foreground)" }}>
          One alert row carries one event set plus an email and/or a webhook channel; the
          two channels are split here for clarity.
        </div>
      </div>
    </div>
  );
}

// Operations > Limits: spend cap / reliability / runtime / approvals / egress,
// read from the worker.yml manifest (runtime.limits + connection approval flags).
function OpsLimitsPanel({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id);
  if (d === undefined) return <Loading />;
  if (d === null) return <DetailError />;
  const runtime = d.config?.runtime;
  const limits = (runtime?.limits ?? {}) as Record<string, unknown>;
  const lim = (k: string): React.ReactNode => {
    const v = limits[k];
    return v == null || v === "" ? "Not set" : String(v);
  };
  const connections = d.config?.connections ?? [];
  const approvalConns = connections.filter(
    (c) => typeof c === "object" && c !== null && "mcp" in c && (c as { mcp?: { require_approval?: string } }).mcp?.require_approval === "always",
  ).length;
  const egressTargets = connections
    .map((c) => (typeof c === "string" ? c : (c as { app?: string }).app))
    .filter((s): s is string => Boolean(s));
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h4 style={h4}>Spend cap</h4>
        <ConfigInfoGrid
          rows={[
            ["Per run", lim("max_cost_usd")],
            ["Per day", lim("max_cost_usd_per_day")],
          ]}
        />
      </section>
      <section>
        <h4 style={h4}>Reliability</h4>
        <ConfigInfoGrid rows={[["Retries", lim("max_retries")]]} />
      </section>
      <section>
        <h4 style={h4}>Runtime</h4>
        <ConfigInfoGrid
          rows={[
            ["Timeout", lim("timeout_seconds")],
            ["Engine", runtimeSummary({ runner: runtime?.runner ?? d.runner ?? w.runner, runtime: runtime?.type ?? w.runtime })],
          ]}
        />
      </section>
      <section>
        <h4 style={h4}>Approvals</h4>
        <ConfigInfoGrid
          rows={[["Require approval", approvalConns > 0 ? `${approvalConns} connection${approvalConns === 1 ? "" : "s"}` : "Never"]]}
        />
      </section>
      <section>
        <h4 style={h4}>Network egress (declared)</h4>
        {egressTargets.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {egressTargets.map((t) => (
              <span key={t} className="c-vpill" style={{ padding: "4px 9px" }}>{t}</span>
            ))}
          </div>
        ) : (
          <div style={{ ...muted, fontSize: 12.5 }}>No connected apps declared.</div>
        )}
      </section>
      {/* Preserved proven content: backend-gated worker feedback moderation. */}
      <WorkerFeedbackSection w={w} />
    </div>
  );
}

// Operations: PRIMARY tab hosting the second-row sub-tabs. Reuses .c-dtabs2 /
// .c-dtab2 (the smaller straight-ink underline variant) — NO sidebar.
function OperationsTab({ w }: { w: WorkerSummary }) {
  const router = useRouter();
  const [sub, setSub] = useState<OperationsSubtab>("Inputs");
  const counts = useOperationsSubCounts(w);
  return (
    <div className="flex flex-col">
      {/* Visual-editor-of-worker.yml framing + View-as-YAML deep-link to Source. */}
      <div className="c-ops-frame">
        <span>Visual editor of worker.yml</span>
        <Link
          href={`/workers?sel=${encodeURIComponent(w.id)}&tab=Source`}
          className="ml-auto normal-case"
          style={{ fontSize: 11, letterSpacing: 0 }}
          onClick={(e) => {
            e.preventDefault();
            router.replace(`/workers?sel=${encodeURIComponent(w.id)}&tab=Source`);
          }}
        >
          View as YAML →
        </Link>
      </div>
      <div className="c-dtabs2" role="tablist" aria-label="Operations">
        {OPERATIONS_SUBTABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={sub === key}
            className={`c-dtab2 ${sub === key ? "on" : ""}`}
            onClick={() => setSub(key)}
          >
            {key}
            {counts[key] != null && <span className="cb">{counts[key]}</span>}
          </button>
        ))}
      </div>
      <div style={{ paddingTop: 16 }}>
        {sub === "Inputs" && <OpsInputsPanel w={w} />}
        {sub === "Alerts & webhooks" && <OpsAlertsPanel w={w} />}
        {sub === "Triggers" && <TriggersTab w={w} />}
        {sub === "Limits" && <OpsLimitsPanel w={w} />}
      </div>
    </div>
  );
}

/** Small count badges for the Operations sub-tabs, derived from the manifest. */
function useOperationsSubCounts(w: WorkerSummary): Partial<Record<OperationsSubtab, number>> {
  const [d] = useWorkerDetail(w.id);
  return useMemo(() => {
    const inputs = (d?.config?.inputs ?? w.inputs ?? []).length;
    const triggers =
      (d?.triggers_spec && d.triggers_spec.length > 0
        ? d.triggers_spec.length
        : d?.config?.trigger
          ? 1
          : 0) || undefined;
    return {
      Inputs: inputs || undefined,
      Triggers: triggers,
    };
  }, [d, w.inputs]);
}

// Tab key → its (named) component, keyed by WORKER_DETAIL_TABS so the §4
// contract test guards the live tab set, not a parallel constant.
const WORKER_TAB_COMPONENT: Record<WorkerDetailTab, (props: { w: WorkerSummary }) => React.ReactNode> = {
  Overview: OverviewTab,
  Runs: RunsTab,
  Operations: OperationsTab,
  Source: SourceTab,
  Versions: VersionsTab,
  Brain: BrainTab,
  Tools: ToolsTab,
};

/**
 * R8 "Customize" control — a quiet, muted affordance next to the worker-detail
 * tab row that lets a user pin the advanced tabs (Source / Versions / Brain / Tools)
 * into their tab bar. Pins are a per-user GLOBAL preference (every worker), not
 * per-worker. Checking an item pins the tab AND selects it; unchecking removes
 * it. Uses the shared DropdownMenu checkbox primitives (flat, tokens, squircle,
 * no borders, no accent — accent is links-only).
 */
function CustomizeTabsMenu({
  workerId,
  pinned,
  onToggle,
  onSelectTab,
}: {
  workerId: string;
  pinned: Set<WorkerDetailTab>;
  onToggle: (key: WorkerDetailTab) => void;
  onSelectTab: (workerId: string, key: WorkerDetailTab) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="c-vpill inline-flex items-center gap-1.5"
        style={customizePillStyle}
        aria-label="Customize tabs"
        title="Pin Source, Versions, Brain or Tools tabs"
      >
        <Plus className="size-3.5" aria-hidden="true" />
        Customize
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 p-1">
        {/* base-ui MenuPrimitive.GroupLabel REQUIRES a Menu.Group ancestor —
            rendering DropdownMenuLabel bare crashes the detail pane. Wrap the
            label + items in DropdownMenuGroup. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Pinned tabs</DropdownMenuLabel>
          {ADVANCED_DETAIL_TABS.map((key) => (
            <DropdownMenuCheckboxItem
              key={key}
              checked={pinned.has(key)}
              // base-ui fires onClick before state churn; closeOnClick stays open so
              // the user can pin several tabs without reopening the menu.
              closeOnClick={false}
              onCheckedChange={(checked) => {
                onToggle(key);
                // Pinning selects the tab so the user lands on what they just added.
                if (checked) onSelectTab(workerId, key);
              }}
            >
              {key}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  const [shareOpen, setShareOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runInputs, setRunInputs] = useState<Record<string, unknown>>({});
  const [runFileNames, setRunFileNames] = useState<Record<string, string>>({});
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState(w.name);
  const [description, setDescription] = useState(w.description ?? "");

  const inputs = d?.config?.inputs ?? w.inputs ?? [];

  useEffect(() => {
    if (!runOpen) return;
    const next: Record<string, unknown> = {};
    for (const input of inputs) {
      next[input.name] =
        runInputs[input.name] ?? (input.default == null ? "" : input.default);
    }
    setRunInputs(next);
    setRunErrors({});
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
    // Schema-driven required-field validation (same rule as the run page).
    const errors = requiredRunInputErrors(inputs, runInputs);
    if (Object.keys(errors).length > 0) {
      setRunErrors(errors);
      toast.error("Fill in the required inputs before running.");
      return;
    }
    setRunErrors({});
    setRunning(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const input of inputs) {
        const value = runInputs[input.name];
        if (value === undefined || value === null) continue;
        if (typeof value === "string") {
          if (value.trim() === "") continue;
          payload[input.name] = coerceInputValue(value, input.type);
        } else {
          // Booleans, uploaded-file shas, arrays/objects pass through as-is.
          payload[input.name] = value;
        }
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
            {/* Pause/Resume — there is no dedicated endpoint yet (#788); enabled
                toggles through the worker.yml PUT, the same path Tools/Brain use. */}
            <DropdownMenuItem
              onClick={() => {
                if (!d) {
                  toast.error("Worker detail still loading.");
                  return;
                }
                const pausing = w.enabled !== false;
                const yaml = patchTopLevelRaw(workerYml(d), "enabled", pausing ? "false" : "true");
                persistYml(d, yaml)
                  .then((updated) => {
                    applyDetail(updated);
                    onUpdated({ ...w, enabled: !pausing });
                    toast.success(pausing ? "Worker paused" : "Worker resumed");
                  })
                  .catch((err: Error) => toast.error(err.message || "Could not update worker"));
              }}
            >
              {w.enabled === false ? "Resume" : "Pause"}
            </DropdownMenuItem>
            {/* Share — opens the real Share modal (company access + grants +
                anonymous public link with revoke), not a bare copy-link. */}
            <DropdownMenuItem onClick={() => setShareOpen(true)}>Share</DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const next = workerStageKey(w) === "live" ? "draft" : "live";
                api.workers.setStage(w.id, next)
                  .then((updated) => {
                    toast.success(next === "live" ? "Marked as live" : "Marked as draft");
                    onUpdated({ ...w, stage: updated.stage });
                  })
                  .catch((err: Error) => toast.error(err.message || "Could not update stage"));
              }}
            >
              {workerStageKey(w) === "live" ? "Mark as draft" : "Mark as live"}
            </DropdownMenuItem>
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
        <DialogContent className="max-h-[88vh] overflow-hidden p-0 sm:max-w-xl">
          <form onSubmit={(event) => void submitRun(event)} className="flex max-h-[88vh] flex-col">
            <DialogHeader className="px-6 pt-6 pb-1">
              <DialogTitle>Run {w.name}</DialogTitle>
              <DialogDescription>
                {inputs.length === 0
                  ? "This worker takes no inputs. Run it now to start a manual run."
                  : "Fill in the inputs below to start a manual run."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
              {w.enabled === false && (
                <div className="rounded-[var(--radius-card)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-3 py-2 text-sm text-[var(--warning)]">
                  This worker is paused. Running it manually may not behave as expected.
                </div>
              )}
              {/* Schema-driven form: renders the correct widget per input type
                  (textarea, select, boolean checkbox, file/CSV, number, text)
                  with labels, required markers, placeholders and validation,
                  the same WorkerInputForm used by the /run page (single source
                  of truth). */}
              <WorkerInputForm
                inputs={inputs}
                values={runInputs}
                fileNames={runFileNames}
                validationErrors={runErrors}
                onInputChange={(inputName, value) => {
                  setRunInputs((prev) => ({ ...prev, [inputName]: value }));
                  setRunErrors((prev) => {
                    if (!prev[inputName]) return prev;
                    const next = { ...prev };
                    delete next[inputName];
                    return next;
                  });
                }}
                onFileUploaded={(inputName, sha256, fileName) => {
                  setRunInputs((prev) => ({ ...prev, [inputName]: sha256 }));
                  setRunFileNames((prev) => ({ ...prev, [inputName]: fileName }));
                }}
              />
            </div>
            <DialogFooter className="px-6 pb-6 pt-2">
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

      <ShareModal
        open={shareOpen}
        onOpenChange={setShareOpen}
        asset={{ type: "worker", name: w.name }}
        companyAccess={{
          visibility: d?.visibility ?? w.visibility ?? "private",
          setVisibility: async (next) => {
            const updated = await api.workers.setVisibility(w.id, next);
            applyDetail(updated);
            onUpdated({ ...w, visibility: updated.visibility });
            return updated.visibility;
          },
          grantAsset: { type: "worker", id: w.id },
        }}
        publicLink={{
          create: async () => (await api.workers.shareLink(w.id)).url,
          revoke: async () => {
            await api.workers.revokeShareLink(w.id);
          },
        }}
      />

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


/**
 * A host-injected top-level view (#1006). managed-deployment passes its
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
  // Cache-first workers list (TanStack Query): returning to /workers renders
  // instantly from cache with no skeleton; a slow/failed refetch keeps showing
  // the cached list instead of flashing "Something went wrong". Local `workers`
  // state is kept in sync so the existing optimistic mutation handlers (delete,
  // update, archive) still work.
  const workersQuery = useWorkers(
    { include_archived: true },
    initialWorkers.length > 0 ? initialWorkers : undefined,
  );
  const [workers, setWorkers] = useState<WorkerSummary[]>(initialWorkers);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [canManageWorkers, setCanManageWorkers] = useState(false);
  const [activeView, setActiveView] = useState<string>(WORKERS_VIEW_KEY);
  // R8 — pinnable advanced tabs (replaces the binary Advanced toggle): the
  // default tab bar stays Overview · Runs; the power-user tabs (Config, Source,
  // Versions) are pinned per-user (global, all workers) via the "Customize"
  // control. Persisted to localStorage so a user who pins Source always sees it.
  const [pinnedTabs, setPinnedTabs] = useState<Set<WorkerDetailTab>>(new Set());
  useEffect(() => {
    setPinnedTabs(getPinnedTabs());
  }, []);
  const togglePinnedTab = useCallback((key: WorkerDetailTab) => {
    setPinnedTabs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      savePinnedTabs(next);
      return next;
    });
  }, []);
  // Selecting a tab = navigate to ?sel=<id>&tab=<key>; CollectionView reads the
  // `tab` URL param to drive the active tab. replace() avoids a history entry.
  const selectWorkerTab = useCallback(
    (workerId: string, key: WorkerDetailTab) => {
      router.replace(
        `/workers?sel=${encodeURIComponent(workerId)}&tab=${encodeURIComponent(key)}`,
      );
    },
    [router],
  );

  useEffect(() => {
    if (workersQuery.data) {
      setWorkers((prev) => {
        const fresh = workersQuery.data!.filter((w) => !isSystemWorker(w));
        // Preserve any on-demand-hydrated worker (see hydration effect below)
        // that the cache-first list doesn't include yet, so a freshly-opened
        // worker doesn't blink out when the background refetch resolves.
        const freshIds = new Set(fresh.map((w) => w.id));
        const carry = prev.filter((w) => !freshIds.has(w.id) && hydratedIdsRef.current.has(w.id));
        return [...fresh, ...carry];
      });
    }
  }, [workersQuery.data]);

  // BUG FIX (open-worker "Item not found … old ID format"): the workers list is
  // cache-first (staleTime 30s, refetchOnMount:false), so a deep-link or Emily
  // "Open worker" to a worker that isn't in the cached list yet (e.g. one just
  // created) resolves to null in CollectionView → false "not found" toast +
  // cleared selection. The id format is fine (slugs match); the list is just
  // stale. When ?sel points at an id we don't have, fetch it by id and merge a
  // summary so the selection resolves. api.workers.get(id) resolves the same
  // slug ids used everywhere, so this is robust to the link format.
  const searchParams = useSearchParams();
  const selParam = searchParams.get("sel");
  const hydratedIdsRef = useRef<Set<string>>(new Set());
  const hydratingIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selParam) return;
    if (workers.some((w) => w.id === selParam)) return; // already present
    // Wait for the initial list load to settle before deciding it's missing,
    // so we don't fire a redundant fetch during the first paint.
    if (workersQuery.isLoading) return;
    if (hydratingIdRef.current === selParam) return; // in flight
    hydratingIdRef.current = selParam;
    let alive = true;
    api.workers
      .get(selParam)
      .then((d) => {
        if (!alive) return;
        hydratedIdsRef.current.add(d.id);
        detailCache.set(d.id, d); // warm the detail-pane cache too
        setWorkers((prev) =>
          prev.some((w) => w.id === d.id) ? prev : [detailToSummary(d), ...prev],
        );
      })
      .catch(() => {
        // Genuinely missing/inaccessible worker → let CollectionView surface the
        // existing "not found" toast (the real not-found path, not a stale list).
      })
      .finally(() => {
        if (hydratingIdRef.current === selParam) hydratingIdRef.current = null;
      });
    return () => {
      alive = false;
    };
  }, [selParam, workers, workersQuery.isLoading]);

  // Skeleton only on a true cold start (no cache and no server data); a slow
  // backend with cached data shows the cache, never the skeleton or the error.
  const loading = workersQuery.isLoading && workers.length === 0;
  const error =
    workersQuery.isError && workers.length === 0
      ? "Could not load workers. Check your connection and try again."
      : null;

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
    return () => {
      alive = false;
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
      stage: [
        { value: "draft", label: "Draft" },
        { value: "live", label: "Live" },
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
      const isDraft = workerStageKey(w) === "draft";
      const isPrivate = w.visibility === "private";
      return {
        // V4 SPEC rule 3: no avatar monogram. Lock is small+muted inline after name.
        // Draft = quiet muted pill (mess-control); live shows nothing (calm default).
        leading: undefined,
        name: (isPrivate || isDraft)
          ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="truncate">{w.name}</span>
              {isPrivate && <Lock className="size-3 shrink-0 text-[var(--muted-foreground)]" />}
              {isDraft && <span className="c-vpill shrink-0" style={{ color: "var(--muted-foreground)" }}>Draft</span>}
            </span>
          )
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
        <>
          {/* R8 Customize control: replaces the binary Advanced toggle. A quiet,
              muted "+ Customize" affordance opens a flat checkbox menu to pin
              the advanced tabs (Source / Versions / Brain / Tools) into the tab bar.
              Pins are a per-user GLOBAL preference (every worker), persisted to
              localStorage — a user who pins Source always sees it. */}
          <CustomizeTabsMenu
            workerId={w.id}
            pinned={pinnedTabs}
            onToggle={togglePinnedTab}
            onSelectTab={selectWorkerTab}
          />
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
        </>
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
              {workerStageKey(w) === "draft" && (
                <span className="c-vpill" style={{ color: "var(--muted-foreground)" }}>Draft</span>
              )}
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
        // R8: operator-focused tab set — Overview + Runs always visible; the
        // advanced tabs (Source / Versions / Brain / Tools) appear only when the user
        // has pinned them via Customize. Pinned tabs render in canonical order
        // after the base tabs. WORKER_DETAIL_TABS (typed constant) stays the
        // 5-tab contract; the UI filters at render time without touching it.
        tabs: (() => {
          const visibleKeys: WorkerDetailTab[] = [
            ...BASE_DETAIL_TABS,
            ...ADVANCED_DETAIL_TABS.filter((t) => pinnedTabs.has(t)),
          ];
          return visibleKeys.map((key) => {
            const Tab = WORKER_TAB_COMPONENT[key];
            return {
              key,
              label: key,
              // #1251: badge matches the count listed in the Runs tab.
              count: key === "Runs"
                ? (detailCache.get(w.id)?.recent_runs?.length
                    ?? (w.last_run ? 1 : undefined))
                : undefined,
              render: () => <Tab w={w} />,
            };
          });
        })(),
      };
    },
    // Contextual toolbar action only; the global sidebar CTA was removed for v4.
    add: { label: "Add", onSelect: () => router.push("/chat?mode=create") }, // #902: create = Emily flow
    states: {
      // #1364 — improved help text + action CTA linking to /workers/new
      empty: {
        title: "No workers yet",
        help: "Workers are AI agents that run on a schedule, webhook, or on demand, powered by your connected apps.",
        action: (
          <WorkersEmptyPrompt
            onSubmit={(prompt) => router.push(`/chat?mode=create&q=${encodeURIComponent(prompt)}`)}
          />
        ),
      },
      errorRetry: () => {
        void workersQuery.refetch();
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
// R8 Customize control: quiet + muted (not accent — accent is links-only). It
// sits next to the worker actions and stays unobtrusive but findable.
const customizePillStyle: React.CSSProperties = {
  padding: "6px 11px",
  fontSize: 12.5,
  background: "var(--bg-2)",
  color: "var(--muted-foreground)",
};
