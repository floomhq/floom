"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, getPersistedActiveWorkspaceId, setActiveWorkspaceId } from "@/lib/api";
import { reportError, logError } from "@/lib/notify";
import { useWorkers, useStreamedInitialData, qk, WORKERS_LIST_QUERY_OPTS } from "@/lib/query/hooks";
import { WORKSPACE_SCOPED_QUERY_ROOTS } from "@/lib/query/workspace";
import type {
  WorkerSummary,
  WorkerDetail,
  WorkerContextSpec,
  WorkerConnectionSpec,
  WorkerFile,
  VersionSummary,
  RunSummary,
  TriggerSpec,
  WorkerAlert,
} from "@/lib/types";
import { formatVersionRows } from "@/lib/workers/versions";
import {
  WORKER_DETAIL_TAB_LABEL,
  type WorkerDetailTab,
  SETUP_SUBTABS,
  type SetupSubtab,
} from "@/lib/workers/tabs";
import { formatDuration } from "@/lib/runs/format";
import { formatAbsolute } from "@/lib/formatters";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ActionMenu } from "@/components/ui/action-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { CollectionConfig, CustomTabReason, TagFamilyKey } from "@/lib/collection/types";
import {
  Collection,
  DetailChips,
  DetailActions,
  DetailEmpty,
  DetailGroup,
  DetailNote,
  DetailRow,
  DetailSummary,
} from "@/components/collection";
import { LoadingState } from "@/components/collection/CollectionStates";
import {
  ArrowRight,
  Archive,
  Brain,
  ChevronDown,
  CopyPlus,
  Edit3,
  Lock,
  Mail,
  PauseCircle,
  PlayCircle,
  Plus,
  RotateCcw,
  Share2,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { BRAIN_FILE_META, inferBrainFileType } from "@/lib/brain/file-type-icon";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { WorkerIconPills } from "@/components/WorkerIconPills";
import { Sparkline } from "@/components/Sparkline";
import { WorkerFlow } from "@/components/WorkerFlow";
import {
  FilesEditor,
  TriggersEditor,
  makeTriggerRow,
  buildTriggersYaml,
  replaceTriggerBlock,
  type TriggerRow,
} from "@/components/worker-form";
import { WorkerInputForm } from "@/components/run-page/WorkerInputForm";
import { ShareModal } from "@/components/sharing/ShareModal";
import { WorkerBrainEditor } from "@/components/worker/WorkerBrainEditor";
import { WorkerToolsEditor, type ToolAppOption } from "@/components/worker/WorkerToolsEditor";
import { WorkerFeedbackPanel } from "@/components/worker/WorkerFeedbackPanel";
import { VersionDiffPanel } from "@/components/VersionDiffPanel";
import {
  connectionSpecApp,
  contextSpecName,
  patchBrainContexts,
  patchWorkerConnections,
  setContextWriteable,
  toggleContext,
} from "@/lib/worker-manifest";
import { can, isViewOnly, canLeaveFeedback, visibilityLabel, FEEDBACK_BACKEND_AVAILABLE } from "@/lib/permissions";
import { isCloudDeploy, getPublicSiteOrigin } from "@/lib/api-base";
import {
  isSystemWorker,
  workerStatusPill,
  workerStageKey,
  workerTags,
  contentTagOptions,
  orderedSourceFiles,
} from "@/lib/workers/derive";
import { getFavorites, saveFavorites } from "@/lib/workers/favorites";
import { safeStorageGet, safeStorageSet } from "@/lib/safe-storage";
import { ADVANCED_DETAIL_TABS, BASE_DETAIL_TABS } from "@/lib/workers/pinned-tabs";
import { ADVANCED_MODE_STORAGE_KEY } from "@/lib/workers/tabs";
import { sortWorkersByRecentActivity } from "@/lib/worker-list-order";
import { useWorkspaceHref } from "@/lib/useWorkspaceHref";

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
    // P2-2 (#1565): label the success rate so a bare "29%" isn't alarming/ambiguous.
    parts.push(`${Math.round(s.success_rate_7d * 100)}% success`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function isScheduleTriggerType(value?: string | null): boolean {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "schedule" || normalized === "cron" || normalized === "scheduled";
}

function workerHasSchedule(w: WorkerSummary, d?: WorkerDetail | null): boolean {
  if (isScheduleTriggerType(d?.config?.trigger?.type ?? w.trigger_type)) return true;
  const specs = d?.triggers_spec && d.triggers_spec.length > 0 ? d.triggers_spec : w.triggers_spec;
  return (specs ?? []).some((trigger) => isScheduleTriggerType(trigger.type));
}

function scheduleStateLabel(w: WorkerSummary, d?: WorkerDetail | null): string | null {
  if (!workerHasSchedule(w, d)) return null;
  const enabled = d?.enabled ?? w.enabled;
  if (enabled === false) return "Paused - disabled";
  const stage = workerStageKey({ ...w, stage: d?.stage ?? w.stage });
  return stage === "draft" ? "Active - draft" : "Active";
}

function displayBrandCopy(value?: string | null): string {
  const legacyAllCapsSuffix = new RegExp(`\\bWorker${"OS"}\\b`, "g");
  const legacyTitle = new RegExp(`\\bWorker${"os"}\\b`, "g");
  return (value ?? "").replace(legacyAllCapsSuffix, "Floom").replace(legacyTitle, "Floom");
}

// ---- detail (lazy WorkerDetail, scoped by workspace so identities never bleed) ----
const DETAIL_CACHE_FRESH_MS = 250;
type DetailCacheEntry = {
  detail?: WorkerDetail;
  fetchedAt: number;
  promise?: Promise<WorkerDetail>;
};
const detailCache = new Map<string, DetailCacheEntry>();

function activeWorkspaceScope(fallback?: string | null): string {
  if (fallback) return fallback;
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search || "");
    const urlWorkspace = params.get("workspace_id") || params.get("ws");
    if (urlWorkspace) return urlWorkspace;
  }
  return getPersistedActiveWorkspaceId() || "local-default";
}

function detailCacheKey(workspaceId: string | null | undefined, workerId: string): string {
  return `${activeWorkspaceScope(workspaceId)}:${workerId}`;
}

function cacheWorkerDetail(detail: WorkerDetail, workspaceId?: string | null) {
  detailCache.set(detailCacheKey(workspaceId ?? detail.workspace_id, detail.id), {
    detail,
    fetchedAt: Date.now(),
  });
}

function readFreshWorkerDetail(workspaceId: string | null | undefined, workerId: string): WorkerDetail | undefined {
  const entry = detailCache.get(detailCacheKey(workspaceId, workerId));
  if (!entry?.detail) return undefined;
  return Date.now() - entry.fetchedAt <= DETAIL_CACHE_FRESH_MS ? entry.detail : undefined;
}

// Returns [detail, apply] where detail is:
//   undefined → still loading
//   null      → load failed (show an error/empty state)
//   WorkerDetail → loaded
function useWorkerDetail(
  id: string,
  workspaceId?: string | null,
): [WorkerDetail | undefined | null, (d: WorkerDetail) => void] {
  const cacheKey = detailCacheKey(workspaceId, id);
  const [detail, setDetail] = useState<WorkerDetail | undefined | null>(() =>
    readFreshWorkerDetail(workspaceId, id)
  );
  useEffect(() => {
    let alive = true;
    // settled = true once the load resolves or fails, so the safety timeout
    // below does not overwrite a successfully-loaded detail (stale-closure fix).
    let settled = false;
    const fresh = readFreshWorkerDetail(workspaceId, id);
    if (fresh) {
      setDetail(fresh);
      settled = true;
      return () => {
        alive = false;
      };
    }
    setDetail(undefined);
    // Retry once before surfacing an error — a transiently slow backend should
    // not strand the detail tabs on "Could not load" (#1279 + round-03 source-load).
    const load = (attempt: number) => {
      const existing = detailCache.get(cacheKey);
      const request = existing?.promise ?? api.workers.get(id);
      detailCache.set(cacheKey, {
        detail: existing?.detail,
        fetchedAt: existing?.fetchedAt ?? 0,
        promise: request,
      });
      request
        .then((d) => {
          settled = true;
          cacheWorkerDetail(d, workspaceId);
          if (alive) setDetail(d);
        })
        .catch((err) => {
          if (!alive) return;
          const entry = detailCache.get(cacheKey);
          if (entry?.promise === request) {
            detailCache.delete(cacheKey);
          }
          if (attempt < 1) setTimeout(() => load(attempt + 1), 1500);
          else {
            settled = true;
            // #1446: per-worker detail; log only (no toast per expanded worker).
            logError("Could not load worker details.", err);
            setDetail(null); // null = failed to load → tabs show error, not a spinner
          }
        });
    };
    load(0);
    // Safety timeout: if the API proxy hangs entirely, surface an error after 25 s
    // (long enough to cover the retry above). Guard with `settled` so a
    // successfully-loaded detail is never overwritten by this stale callback.
    const timeout = setTimeout(() => {
      if (alive && !settled) setDetail(null);
    }, 25_000);
    return () => {
      alive = false;
      clearTimeout(timeout);
    };
  }, [cacheKey, id, workspaceId]);
  const apply = useCallback(
    (d: WorkerDetail) => {
      cacheWorkerDetail(d, workspaceId);
      setDetail(d);
    },
    [workspaceId],
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
  const summary = {
    id: d.id,
    workspace_id: d.workspace_id,
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
  if (d.last_run !== undefined) summary.last_run = d.last_run;
  if (d.recent_stats !== undefined) summary.recent_stats = d.recent_stats;
  if (d.timeseries !== undefined) summary.timeseries = d.timeseries;
  return summary;
}

function SelectedWorkerSummaryRefresh({
  workerId,
  onLoaded,
}: {
  workerId: string;
  onLoaded: (detail: WorkerDetail) => void;
}) {
  useEffect(() => {
    let alive = true;
    api.workers
      .get(workerId)
      .then((detail) => {
        if (!alive) return;
        cacheWorkerDetail(detail, detail.workspace_id);
        onLoaded(detail);
      })
      .catch((err) => logError("Could not refresh worker stats.", err));
    return () => {
      alive = false;
    };
  }, [workerId, onLoaded]);
  return null;
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

// L6: Inline activation banner shown when an imported worker has missing
// connections. Dismissible per-worker via sessionStorage. Reuses the
// safeStorageGet/Set helpers already in scope. No new design primitives.
function MissingConnectionsBanner({ w }: { w: WorkerSummary }) {
  const missing = w.missing_connections ?? [];
  const DISMISS_KEY = `connect-banner-dismissed:${w.id}`;
  const [dismissed, setDismissed] = useState(() => safeStorageGet("session", DISMISS_KEY) === "1");
  const workspaceHref = useWorkspaceHref();

  if (dismissed || missing.length === 0) return null;

  const workerPath = workspaceHref(`/workers?sel=${encodeURIComponent(w.id)}`);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        margin: "0 0 2px",
        padding: "10px 14px",
        background: "var(--bg-2)",
        borderRadius: "var(--radius-card)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
          Connect your tools to bring this worker to life
        </p>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            safeStorageSet("session", DISMISS_KEY, "1");
            setDismissed(true);
          }}
          style={{ flexShrink: 0, padding: 2, color: "var(--ink-faint)", background: "none", border: "none", cursor: "pointer", lineHeight: 1 }}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {missing.map((slug) => (
          <Link
            key={slug}
            href={workspaceHref(
              `/connections/connect/${encodeURIComponent(slug)}?return_to=${encodeURIComponent(workerPath)}`,
            )}
            className="c-addbtn"
            style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <BrandLogo icon={normalizeConnectionSlug(slug)} className="size-3.5" />
            Connect {slug}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Normalise a missing_connections slug for BrandLogo (mirrors WorkerShareCard). */
function normalizeConnectionSlug(slug: string): string {
  const lower = slug.toLowerCase();
  const ALIASES: Record<string, string> = {
    googlecalendar: "google-calendar",
    googledrive: "google-drive",
    googledocs: "google-docs",
    googlesheets: "google-sheets",
    googlemeet: "google-meet",
  };
  return ALIASES[lower] ?? lower;
}

function OverviewTab({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id, w.workspace_id);
  const stats = d === undefined ? undefined : d?.recent_stats ?? w.recent_stats;
  const lastRun = d === undefined ? undefined : d?.last_run ?? w.last_run;
  const scheduleState = scheduleStateLabel(w, d);
  const summaryItems = [
    {
      key: "last-run",
      label: "Last run",
      value: d === undefined ? "Loading" : rel(stats?.last_run_at ?? lastRun?.created_at),
    },
    {
      key: "runs",
      label: "Runs",
      value: d === undefined ? "Loading" : stats?.runs_7d ?? (lastRun ? 1 : 0),
    },
    {
      key: "success",
      label: "Success",
      value: d === undefined
        ? "Loading"
        : typeof stats?.success_rate_7d === "number"
          ? `${Math.round(stats.success_rate_7d * 100)}%`
          : "Not set",
    },
    ...(scheduleState ? [{ key: "schedule", label: "Schedule", value: scheduleState }] : []),
  ];
  return (
    <div>
      {/* L6 activation: missing-connections banner (only when connections unmet) */}
      <MissingConnectionsBanner w={w} />
      {/* #1290: "Latest output" removed — its purpose was unclear to operators
          (Federico: "why is latest output shown?") and it only showed run status +
          ID with no actual output text. The History tab shows the run list. */}
      <DetailSummary items={summaryItems} />
      <AboutBody w={w} d={d} />
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

function AboutBody({ w, d }: { w: WorkerSummary; d?: WorkerDetail | null }) {
  const description = displayBrandCopy(w.long_description || w.description) || "No description yet.";
  const contexts = d?.config?.contexts ?? [];
  const flowConnections = (d?.config?.connections ?? [])
    .map(connectionSpecApp)
    .filter((app): app is string => Boolean(app));
  return (
    <div>
      <DetailGroup label="What it does">
        <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 13 }}>{description}</p>
      </DetailGroup>
      <DetailGroup label="Flow">
        {d === undefined ? (
          <Loading />
        ) : d === null ? (
          <DetailError />
        ) : (
          <WorkerFlow
            workerName={d.name}
            worker={{ id: d.id, name: d.name, connections: flowConnections, tags: d.tags }}
            connections={flowConnections}
            triggerType={d.config?.trigger?.type ?? d.trigger_type}
            inputs={(d.config?.inputs ?? []).map((i) => ({ name: i.name, label: i.label, type: i.type }))}
            outputs={(d.config?.outputs ?? []).map((o) => ({ name: o.name, label: o.label, type: o.type }))}
          />
        )}
      </DetailGroup>
      {contexts.length > 0 && (
        <DetailGroup
          label={(
            <>
            <Brain className="inline-block size-[11px] align-[-1px] mr-1" aria-hidden="true" />
            Library it uses
            </>
          )}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {contexts.map((spec) => {
              const name = contextSpecName(spec);
              return <BrainContextChip key={name} name={name} />;
            })}
          </div>
        </DetailGroup>
      )}
      {d?.use_cases && d.use_cases.length > 0 && (
        <DetailGroup label="Use cases">
          <ul style={{ margin: 0, paddingLeft: 18, color: "var(--ink-soft)" }}>
            {d.use_cases.map((u, i) => (
              <li key={i}>{displayBrandCopy(u)}</li>
            ))}
          </ul>
        </DetailGroup>
      )}
      {d?.how_it_works && (
        <DetailGroup label="How it works">
          <p style={{ margin: 0, color: "var(--ink-soft)" }}>{displayBrandCopy(d.how_it_works)}</p>
        </DetailGroup>
      )}
    </div>
  );
}


// #1679: the embedded per-worker Runs tab must source its rows from the SAME
// query the global /runs surface uses — api.runs.list({ worker_id }) — NOT from
// the worker-detail `recent_runs` field. The detail field is built backend-side
// by runs.list_for_worker (scoped only by `w.owner_id`), whereas /runs is scoped
// by `(actor_user_id OR owner_id)`; for a worker whose runs were triggered by a
// non-owner actor the narrow query returns empty, so the tab showed "No runs yet"
// while /runs showed the full history for the same worker. Using the proven
// worker-scoped list query here makes the two surfaces agree.
//
// Module-level cache keyed by worker id so returning to a worker's Runs tab is
// instant and never blanks.
const workerRunsCache = new Map<string, RunSummary[]>();
const WORKER_RUNS_LIMIT = 20;

function useWorkerRuns(workerId: string): RunSummary[] | undefined {
  const [runs, setRuns] = useState<RunSummary[] | undefined>(() =>
    workerRunsCache.get(workerId),
  );
  useEffect(() => {
    let alive = true;
    // Serve the cache immediately, then refresh in the background so a return to
    // the tab is instant and never blanks (mirrors the worker-detail cache).
    const cached = workerRunsCache.get(workerId);
    if (cached) setRuns(cached);
    api.runs
      .list({ worker_id: workerId, limit: WORKER_RUNS_LIMIT })
      .then((rows) => {
        workerRunsCache.set(workerId, rows);
        if (alive) setRuns(rows);
      })
      // #1446: per-worker tab; log only (no toast per expanded worker).
      .catch((err) => logError("Could not load runs for this worker.", err));
    return () => {
      alive = false;
    };
  }, [workerId]);
  return runs;
}

// Runs: recent runs w/ durations, link to the full Runs surface.
function RunsTab({ w }: { w: WorkerSummary }) {
  const fetched = useWorkerRuns(w.id);
  const workspaceHref = useWorkspaceHref();
  const [d] = useWorkerDetail(w.id, w.workspace_id);
  // Until the worker-scoped fetch resolves, fall back to the summary's last_run
  // so the tab is never momentarily empty for a worker that has run.
  const lastRun = d?.last_run ?? w.last_run;
  const runs = fetched ?? (lastRun ? [lastRun] : []);
  const stats = d?.recent_stats ?? w.recent_stats;
  return (
    <div>
      <DetailSummary
        items={[
          { key: "last-run", label: "Last run", value: rel(stats?.last_run_at ?? lastRun?.created_at) },
          { key: "runs-7d", label: "Runs", value: stats?.runs_7d ?? runs.length },
          {
            key: "success",
            label: "Success",
            value: typeof stats?.success_rate_7d === "number"
              ? `${Math.round(stats.success_rate_7d * 100)}%`
              : "Not set",
          },
        ]}
      />
      <DetailGroup
        label={(
          <span className="flex items-center gap-2">
            <span>Recent runs</span>
            <Link href={workspaceHref(`/runs?worker_id=${w.id}`)} className="c-vpill normal-case" style={{ padding: "4px 8px", letterSpacing: 0 }}>
              All runs →
            </Link>
          </span>
        )}
      >
        <div className="c-ltable">
          {runs.map((r) => (
            <Link
              key={r.id}
              href={workspaceHref(`/runs/${encodeURIComponent(r.id)}`)}
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
          {runs.length === 0 && <DetailEmpty>No runs yet.</DetailEmpty>}
        </div>
      </DetailGroup>
    </div>
  );
}

// SPEC §4 Versions: git log in the GLOBAL list style — message + `sha · author ·
// age`, current marker, Diff (modal) + Restore (confirm). Endpoints BUILT.
function VersionsTab({ w }: { w: WorkerSummary }) {
  const [d, applyDetail] = useWorkerDetail(w.id, w.workspace_id);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  // #1249: store both version files AND current files so the modal can show a
  // proper line-level diff (VersionDiffPanel) instead of a raw file view.
  const [diff, setDiff] = useState<{
    id: string;
    versionFiles: { path: string; content: string }[];
    currentFiles: { path: string; content: string }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoreId, setRestoreId] = useState<string | null>(null);
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
  if (versions.length === 0) {
    return (
      <DetailGroup label="Version history">
        <DetailEmpty>No version history yet.</DetailEmpty>
      </DetailGroup>
    );
  }
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
    setBusy(true);
    try {
      applyDetail(await api.workers.rollback(w.id, id));
      toast.success(`Restored to ${id.slice(0, 7)}`);
      setVersions(await api.workers.listVersions(w.id));
      setRestoreId(null);
      setDiff(null);
    } catch {
      toast.error("Could not restore that version.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ConfirmDialog
        open={restoreId !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRestoreId(null);
        }}
        title={restoreId ? `Restore worker to ${restoreId.slice(0, 7)}?` : "Restore worker version?"}
        body="This commits a new version with the selected source files."
        confirmLabel="Restore"
        loading={busy}
        onConfirm={() => {
          if (restoreId) void restore(restoreId);
        }}
      />
      <DetailGroup label="Version history">
        <p className="c-dctx">{rows.length} versions · current diff state preserved</p>
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
                    onClick={() => setRestoreId(r.id)}
                  >
                    Restore
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </DetailGroup>
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
              onRestore={() => setRestoreId(diff.id)}
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
  const [d, applyDetail] = useWorkerDetail(w.id, w.workspace_id);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [draftFiles, setDraftFiles] = useState<{ path: string; content: string; binary?: boolean; language?: string; size?: number }[]>([]);
  const [draftPath, setDraftPath] = useState<string>("worker.yml");
  const [saving, setSaving] = useState(false);

  if (d === undefined) return <Loading />;
  if (d === null) return <DetailError />;

  const ordered = orderedSourceFiles(d.files ?? []);
  if (ordered.length === 0) {
    return (
      <DetailGroup label="Source">
        <DetailEmpty>No source files.</DetailEmpty>
      </DetailGroup>
    );
  }

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
      <DetailGroup label="Source">
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
      </DetailGroup>
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="grid h-[min(90vh,860px)] max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0 sm:max-w-6xl">
          <DialogHeader className="px-6 pt-5 pb-3">
            <DialogTitle>Edit source</DialogTitle>
            <DialogDescription>Update this worker&apos;s source files.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-6 pb-4">
            <FilesEditor
              mode="edit"
              files={draftFiles}
              selectedPath={draftPath}
              onChange={setDraftFiles}
              onSelectedPathChange={setDraftPath}
            />
          </div>
          <DialogFooter className="sticky bottom-0 z-10 m-0 rounded-none">
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
  const [d, applyDetail] = useWorkerDetail(w.id, w.workspace_id);
  const [packs, setPacks] = useState<{ name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const refreshPacks = useCallback(() => {
    api.contexts
      .list()
      .then(setPacks)
      .catch((err) => reportError("Could not load your Library.", err));
  }, []);
  useEffect(() => {
    refreshPacks();
  }, [refreshPacks]);
  if (d === undefined) return <Loading />;
  if (d === null) return <DetailError />;
  const editable = can("edit", d);
  const contexts = d.config?.contexts ?? [];
  // Per-worker memory folder. MUST match the engine convention
  // (models.default_worker_memory_context_name = "memory-<id>", overridable via
  // memory.context); the old "<id>-memory" guess never matched the folder the
  // engine actually mounts, so the Connect-CTA and pin detection both missed.
  const memoryEnabled = d.config?.memory?.enabled !== false;
  const memoryFolderName = d.config?.memory?.context || `memory-${w.id}`;
  const save = async (next: WorkerContextSpec[]) => {
    setBusy(true);
    try {
      applyDetail(await persistYml(d, patchBrainContexts(workerYml(d), next)));
      toast.success("Library updated");
    } catch {
      toast.error("Could not update the Library.");
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
    <DetailGroup label="Attached folders">
      <p className="c-dctx">
        {contexts.length} folder{contexts.length === 1 ? "" : "s"} · memory folder {contexts.includes(memoryFolderName) ? "attached" : "available"}
      </p>
      <WorkerBrainEditor
        contexts={contexts}
        availablePacks={packs}
        editable={editable}
        busy={busy}
        onChange={(next) => void save(next)}
        memoryFolderName={memoryFolderName}
        memoryPinned={memoryEnabled}
        onAttachMemory={attachMemory}
      />
    </DetailGroup>
  );
}

function ToolsTab({ w }: { w: WorkerSummary }) {
  const [d, applyDetail] = useWorkerDetail(w.id, w.workspace_id);
  const [busy, setBusy] = useState(false);
  // B4: the Add-tool combobox is sourced from the workspace's connected apps
  // (Federico: "we already have the list of connections") plus the integrations
  // catalog, so the user picks from a searchable list instead of free-typing a
  // slug. Per-app allowlist tools come from the catalog, cached per app.
  const [availableApps, setAvailableApps] = useState<ToolAppOption[]>([]);
  const [toolCache, setToolCache] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const apps = new Map<string, ToolAppOption>();
      try {
        const conns = await api.connections.list();
        for (const c of conns) {
          const slug = (c.app_name || "").toLowerCase();
          if (slug) apps.set(slug, { slug, name: c.display_name || c.app_name });
        }
      } catch {
        // Connections unreachable: fall back to catalog only.
      }
      try {
        const catalog = await api.integrations.catalog({ limit: 200 });
        for (const item of catalog.items) {
          const slug = item.slug.toLowerCase();
          if (!apps.has(slug)) apps.set(slug, { slug, name: item.name });
        }
      } catch {
        // Catalog unreachable: connections-only is still useful.
      }
      if (!cancelled) {
        setAvailableApps([...apps.values()].sort((a, b) => a.name.localeCompare(b.name)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Lazy-load + cache the known tools for each connected app so the allowlist
  // multiselect shows real tool names. Returns synchronously from cache.
  const connections = d?.config?.connections ?? [];
  useEffect(() => {
    let cancelled = false;
    const slugs = connections
      .map((s) => (connectionSpecApp(s) || "").toLowerCase())
      .filter((slug) => slug && !(slug in toolCache));
    if (slugs.length === 0) return;
    (async () => {
      for (const slug of slugs) {
        try {
          const tools = await api.integrations.catalogTools(slug);
          if (cancelled) return;
          setToolCache((prev) => ({ ...prev, [slug]: tools.map((t) => t.name) }));
        } catch {
          if (cancelled) return;
          setToolCache((prev) => ({ ...prev, [slug]: [] }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(connections.map((s) => connectionSpecApp(s)))]);

  const toolsForApp = useCallback(
    (slug: string) => toolCache[slug.toLowerCase()] ?? [],
    [toolCache],
  );

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
    <DetailGroup label="Connected tools">
      <p className="c-dctx">
        {(d.config?.connections ?? []).length} connection{(d.config?.connections ?? []).length === 1 ? "" : "s"} · allowlist editor unchanged
      </p>
      <WorkerToolsEditor
        connections={d.config?.connections ?? []}
        editable={editable}
        busy={busy}
        availableApps={availableApps}
        toolsForApp={toolsForApp}
        onChange={(next) => void save(next)}
      />
    </DetailGroup>
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

// Read-only scheduler status (next run / last fired) for scheduled/cron workers.
// Both come straight off the persisted workers row (scheduler bookkeeping). Empty
// for manual / never-fired workers, so nothing renders there.
function scheduleStatusRows(d: WorkerDetail): Array<[string, React.ReactNode]> {
  const rows: Array<[string, React.ReactNode]> = [];
  if (d.next_run_at) rows.push(["Next run", formatAbsolute(d.next_run_at)]);
  if (d.last_fired_at) rows.push(["Last fired", formatAbsolute(d.last_fired_at)]);
  return rows;
}

// W-02: Triggers are EDITABLE — read the current trigger(s) from worker.yml and
// let the owner change the schedule / webhook / app-event / manual via the same
// TriggersEditor used in the create flow. Persists through the worker.yml PUT
// (replaceTriggerBlock → updateFiles), the path Tools/Brain already use.
function TriggersTab({ w }: { w: WorkerSummary }) {
  const [d, applyDetail] = useWorkerDetail(w.id, w.workspace_id);
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
    const scheduleState = scheduleStateLabel(w, d);
    return (
      <DetailGroup label="Trigger">
        <DetailRow label="Type" value={friendlyToken(d.config?.trigger?.type ?? w.trigger_type)} />
        {d.config?.trigger?.cron && <DetailRow label="Cron" value={d.config.trigger.cron} mono />}
        {d.config?.trigger?.timezone && <DetailRow label="Timezone" value={d.config.trigger.timezone} />}
        {d.webhook_url && <DetailRow label="Webhook" value={d.webhook_url} mono />}
        {scheduleState && <DetailRow label="Schedule" value={scheduleState} />}
        {scheduleStatusRows(d).map(([label, value]) => (
          <DetailRow key={label} label={label} value={value} />
        ))}
      </DetailGroup>
    );
  }

  const statusRows = scheduleStatusRows(d);
  const scheduleState = scheduleStateLabel(w, d);

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
    <div className="flex flex-col gap-4">
      {statusRows.length > 0 && (
        <DetailGroup label="Schedule status">
          {scheduleState && <DetailRow label="Schedule" value={scheduleState} />}
          {statusRows.map(([label, value]) => (
            <DetailRow key={label} label={label} value={value} />
          ))}
        </DetailGroup>
      )}
      {statusRows.length === 0 && scheduleState && (
        <DetailGroup label="Schedule status">
          <DetailRow label="Schedule" value={scheduleState} />
        </DetailGroup>
      )}
      <TriggersEditor
        rows={rows}
        onChange={setRows}
        webhookUrl={d.webhook_url}
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        onDiscard={() => setRows(currentTriggerRows(d))}
      />
    </div>
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
// are Developer tabs, Triggers + runtime/limits live under Operations. The proven
// Feedback section (backend-gated) is preserved as a reusable helper and shown in
// the Operations > Limits panel so no proven content is cut.
function WorkerFeedbackSection({ w }: { w: WorkerSummary }) {
  if (!FEEDBACK_BACKEND_AVAILABLE) return null;
  return (
    <DetailGroup label="Feedback">
      <WorkerFeedbackPanel workerId={w.id} canLeave={canLeaveFeedback(w)} canModerate={can("edit", w)} />
    </DetailGroup>
  );
}

// ---- Operations (round-09) ---------------------------------------------------
// Operations is a PRIMARY tab that hosts a SECOND ROW of tabs (no sidebar):
//   Inputs · Alerts & webhooks · Triggers · Limits
// framed as a "Visual editor of worker.yml" with a "View as YAML" deep-link into
// Source. Each panel REUSES the real editors/primitives (WorkerInputForm,
// TriggersEditor via TriggersTab) — no hand-rolled chrome.

/** Persisted named input templates (per-user, per-worker, localStorage). A
 *  worker carries one declared-input schema; an operator saves multiple named
 *  value sets ("Weekly default", "Month-end close") to run from. */
type InputTemplate = { name: string; values: Record<string, unknown> };
function inputTemplatesKey(workerId: string): string {
  return `floom.workerDetail.inputTemplates.${workerId}`;
}
function loadInputTemplates(workerId: string): InputTemplate[] {
  try {
    const raw = safeStorageGet("local", inputTemplatesKey(workerId));
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
  safeStorageSet("local", inputTemplatesKey(workerId), JSON.stringify(templates));
}

// Operations > Inputs: a segmented named-template picker above the REAL
// WorkerInputForm (single source of truth, same widget the /run page uses).
function OpsInputsPanel({ w }: { w: WorkerSummary }) {
  const [d, applyDetail] = useWorkerDetail(w.id, w.workspace_id);
  const inputs = d?.config?.inputs ?? w.inputs ?? [];
  const [templates, setTemplates] = useState<InputTemplate[]>([]);
  const [activeIdx, setActiveIdx] = useState(0); // 0 = "Default" (the saved backend recipe)
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [savingDefault, setSavingDefault] = useState(false);

  useEffect(() => {
    setTemplates(loadInputTemplates(w.id));
  }, [w.id]);

  // The saved backend default-inputs recipe (input_values). This is what
  // scheduled/automated runs actually merge over the schema defaults
  // (scheduler._effective_scheduled_inputs). gap #1: load it so "Default" is
  // the persisted recipe, not a write-blind local guess.
  const savedDefaults = (d?.input_values ?? {}) as Record<string, unknown>;

  // Seed values from the active source:
  //  - "Default" (idx 0): the saved backend recipe, falling back to schema defaults.
  //  - a named template (idx > 0): a local convenience value-set.
  useEffect(() => {
    const tmpl = activeIdx > 0 ? templates[activeIdx - 1] : undefined;
    const next: Record<string, unknown> = {};
    for (const inp of inputs) {
      const fromTemplate = tmpl?.values[inp.name];
      const fromSaved = activeIdx === 0 ? savedDefaults[inp.name] : undefined;
      next[inp.name] =
        fromTemplate ?? fromSaved ?? (inp.default == null ? "" : inp.default);
    }
    setValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, templates, d?.id, d?.input_values]);

  const activeName = activeIdx > 0 ? templates[activeIdx - 1]?.name : "Default";

  // Persist the "Default" set to the backend recipe column (input_values) via
  // PATCH /workers/{id}. This is the gap #1 fix: scheduled runs now have saved
  // values. Named templates remain a per-user local convenience layer.
  const saveDefault = async () => {
    setSavingDefault(true);
    try {
      const updated = await api.workers.updateInputValues(w.id, values);
      applyDetail(updated);
      toast.success("Default inputs saved. Scheduled and automated runs will use these.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save default inputs");
    } finally {
      setSavingDefault(false);
    }
  };

  const saveTemplate = () => {
    if (activeIdx === 0) {
      const name = window.prompt("Name this input template", "Month-end close")?.trim();
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
    <div>
      {/* gap #1 callout: makes the operator-blocking truth explicit. */}
      <DetailGroup>
        <DetailNote>
          <strong style={{ color: "var(--ink)" }}>Default inputs</strong> are what
          scheduled and automated (webhook / app-event) runs use. Save them here so an
          unattended run never fires with an empty required field.
        </DetailNote>
      </DetailGroup>

      {/* Segmented named-template picker (Default + saved templates + New). */}
      <DetailGroup label="Template">
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
      </DetailGroup>

      {/* The REAL schema-driven input form (same component the run dialog uses). */}
      <DetailGroup>
        <p className="c-dctx">
          {inputs.length > 0 ? inputs.map((input) => input.label || input.name).join(" · ") : "No declared inputs"}
        </p>
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
      </DetailGroup>

      {inputs.length > 0 && (
        <DetailActions separated>
          <span style={{ ...muted, fontSize: 12.5 }}>
            Editing {activeName ? `"${activeName}"` : "Default"}
          </span>
          {activeIdx === 0 ? (
            <>
              {/* gap #1: persists to the backend recipe column. */}
              <button
                type="button"
                className="c-addbtn"
                style={pillBtn}
                onClick={() => void saveDefault()}
                disabled={savingDefault}
              >
                {savingDefault ? "Saving…" : "Save default inputs"}
              </button>
              <button
                type="button"
                className="c-vpill"
                style={pillBtn}
                onClick={saveTemplate}
              >
                Save as template
              </button>
            </>
          ) : (
            <button type="button" className="c-addbtn" style={pillBtn} onClick={saveTemplate}>
              Save template
            </button>
          )}
        </DetailActions>
      )}
    </div>
  );
}

// Operations > Alerts & webhooks: CONFIGURABLE per-worker alert rows (#1677).
// Each row fires on selected run terminal events (failed / completed) and
// delivers to an email recipient list and/or an outbound webhook URL. Wired to
// the real CRUD: GET/POST/DELETE /workers/{id}/alerts. Webhook POSTs are signed
// (X-Floom-Signature and legacy x-workeros-signature during the rename window)
// and SSRF-pinned server-side; email goes via Resend.
const ALERT_EVENTS = ["failed", "completed"] as const;
type AlertEvent = (typeof ALERT_EVENTS)[number];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// L3 — "Email me a summary after each run" one-click toggle.
// Creates/removes a completed+failed alert with the signed-in user's email.
// The toggle is ON when an alert row exists whose email_to includes the user's
// email and whose on array covers both "completed" and "failed".
function RunSummaryEmailToggle({
  workerId,
  alerts,
  onChanged,
}: {
  workerId: string;
  alerts: WorkerAlert[] | undefined | null;
  onChanged: () => void;
}) {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.me().then((u) => setUserEmail(u?.email ?? null)).catch(() => {});
  }, []);

  if (!userEmail) return null;

  // Find an existing alert that covers this user's email for both run events.
  const matchingAlert = alerts?.find((a) => {
    const events = new Set(a.on);
    return (
      events.has("completed") &&
      events.has("failed") &&
      Array.isArray(a.email_to) &&
      a.email_to.some((e) => e.toLowerCase() === userEmail.toLowerCase())
    );
  }) ?? null;

  const isOn = matchingAlert !== null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (isOn && matchingAlert) {
        await api.workers.alerts.remove(workerId, matchingAlert.id);
        toast.success("Run email summary disabled.");
      } else {
        await api.workers.alerts.create(workerId, {
          on: ["completed", "failed"],
          email_to: [userEmail],
          description: "Run email summary",
        });
        toast.success(`Run summaries will be emailed to ${userEmail}.`);
      }
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailGroup label="Email summary">
      <div className="c-lrow" style={{ gridTemplateColumns: "1fr auto" }}>
        <div className="c-lp-tx">
          <div className="nm">Email me a summary after each run</div>
          <div className="sub">{isOn ? `Sending to ${userEmail}` : userEmail}</div>
        </div>
        <Switch
          checked={isOn}
          disabled={busy || alerts === undefined}
          onCheckedChange={() => void toggle()}
          aria-label="Email run summary toggle"
        />
      </div>
    </DetailGroup>
  );
}

function OpsAlertsPanel({ w }: { w: WorkerSummary }) {
  const [alerts, setAlerts] = useState<WorkerAlert[] | undefined | null>(undefined);

  const reload = useCallback(async () => {
    try {
      setAlerts(await api.workers.alerts.list(w.id));
    } catch (err) {
      logError("Could not load alerts.", err);
      setAlerts(null);
    }
  }, [w.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div>
      {/* L3: one-click "Email me a summary" toggle — sits above the full config form. */}
      <RunSummaryEmailToggle
        workerId={w.id}
        alerts={alerts}
        onChanged={() => void reload()}
      />

      <DetailGroup label="Configured alerts">
        {alerts === undefined ? (
          <Loading />
        ) : alerts === null ? (
          <DetailError />
        ) : alerts.length === 0 ? (
          <DetailEmpty>
            No alerts yet. Add one below to be notified when this worker&apos;s runs
            fail or complete.
          </DetailEmpty>
        ) : (
          <div className="c-ltable">
            {alerts.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                onDeleted={() => void reload()}
                workerId={w.id}
              />
            ))}
          </div>
        )}
      </DetailGroup>

      <AddAlertForm workerId={w.id} onCreated={() => void reload()} />

      <DetailGroup>
        <DetailNote>
          Webhook POSTs are signed with <code>X-Floom-Signature</code> and legacy{" "}
          <code>x-workeros-signature</code> HMAC headers, and blocked from internal /
          metadata targets. Email delivery goes to workspace members via Resend.
        </DetailNote>
      </DetailGroup>
    </div>
  );
}

// One configured alert: its channels + events, with a delete control.
function AlertRow({
  alert,
  workerId,
  onDeleted,
}: {
  alert: WorkerAlert;
  workerId: string;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    setDeleting(true);
    try {
      await api.workers.alerts.remove(workerId, alert.id);
      toast.success("Alert removed.");
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove alert");
      setDeleting(false);
    }
  };
  return (
    <div
      className="c-lrow"
      style={{ gridTemplateColumns: "1fr auto", alignItems: "flex-start" }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {alert.on.map((ev) => (
            <span key={ev} className="c-vpill" style={{ padding: "3px 8px", fontSize: 11.5 }}>
              on {ev}
            </span>
          ))}
        </div>
        {alert.email_to && alert.email_to.length > 0 && (
          <div className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
            <Mail className="size-3.5 shrink-0" style={{ color: "var(--muted-foreground)" }} aria-hidden="true" />
            <span className="min-w-0 break-words">{alert.email_to.join(", ")}</span>
          </div>
        )}
        {alert.url && (
          <div className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
            <Webhook className="size-3.5 shrink-0" style={{ color: "var(--muted-foreground)" }} aria-hidden="true" />
            <span className="min-w-0 break-words font-mono text-xs">{alert.url}</span>
          </div>
        )}
        {alert.description && (
          <span style={{ ...muted, fontSize: 12 }}>{alert.description}</span>
        )}
      </div>
      <button
        type="button"
        aria-label="Remove alert"
        className="c-vpill shrink-0"
        style={{ padding: "5px 8px", cursor: "pointer" }}
        onClick={() => void remove()}
        disabled={deleting}
        title="Remove alert"
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

// The add-alert form: event toggles + recipient email(s) + webhook URL. At least
// one channel (email or URL) and one event are required. Validates email + URL
// format client-side; the backend re-validates (membership, SSRF) on save.
function AddAlertForm({
  workerId,
  onCreated,
}: {
  workerId: string;
  onCreated: () => void;
}) {
  const [events, setEvents] = useState<Set<AlertEvent>>(new Set(["failed"]));
  const [emails, setEmails] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setEvents(new Set(["failed"]));
    setEmails([]);
    setEmailDraft("");
    setUrl("");
    setDescription("");
  };

  const toggleEvent = (ev: AlertEvent) => {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(ev)) next.delete(ev);
      else next.add(ev);
      return next;
    });
  };

  const addEmail = () => {
    const value = emailDraft.trim();
    if (!value) return;
    if (!EMAIL_RE.test(value)) {
      toast.error(`Not a valid email address: ${value}`);
      return;
    }
    if (emails.includes(value)) {
      setEmailDraft("");
      return;
    }
    setEmails((prev) => [...prev, value]);
    setEmailDraft("");
  };

  const removeEmail = (addr: string) => setEmails((prev) => prev.filter((e) => e !== addr));

  const trimmedUrl = url.trim();
  const urlValid = (() => {
    if (!trimmedUrl) return true; // optional
    try {
      const u = new URL(trimmedUrl);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  })();

  const hasChannel = emails.length > 0 || trimmedUrl.length > 0;
  const canSave = hasChannel && events.size > 0 && urlValid && !saving;

  const save = async () => {
    if (events.size === 0) {
      toast.error("Select at least one event.");
      return;
    }
    if (!hasChannel) {
      toast.error("Add a recipient email or a webhook URL.");
      return;
    }
    if (!urlValid) {
      toast.error("Webhook URL must be a valid http(s) URL.");
      return;
    }
    setSaving(true);
    try {
      await api.workers.alerts.create(workerId, {
        on: ALERT_EVENTS.filter((e) => events.has(e)),
        ...(emails.length > 0 ? { email_to: emails } : {}),
        ...(trimmedUrl ? { url: trimmedUrl } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      toast.success("Alert saved.");
      reset();
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save alert");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DetailGroup label="Add alert">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Events */}
        <div className="flex flex-col gap-2">
          <Label style={{ fontSize: 12.5 }}>Fire on</Label>
          <div className="flex flex-wrap gap-2">
            {ALERT_EVENTS.map((ev) => {
              const on = events.has(ev);
              return (
                <button
                  key={ev}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className="c-vpill"
                  style={{
                    padding: "5px 11px",
                    cursor: "pointer",
                    ...(on
                      ? { background: "var(--bg-3)", color: "var(--ink)", fontWeight: 500 }
                      : {}),
                  }}
                  onClick={() => toggleEvent(ev)}
                >
                  Run {ev}
                </button>
              );
            })}
          </div>
        </div>

        {/* Recipient emails (multi) */}
        <div className="flex flex-col gap-2">
          <Label htmlFor={`alert-email-${workerId}`} style={{ fontSize: 12.5 }}>
            Recipient email(s)
          </Label>
          {emails.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {emails.map((addr) => (
                <span
                  key={addr}
                  className="c-vpill"
                  style={{ padding: "3px 6px 3px 9px", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
                >
                  {addr}
                  <button
                    type="button"
                    aria-label={`Remove ${addr}`}
                    onClick={() => removeEmail(addr)}
                    style={{ display: "inline-flex", cursor: "pointer", color: "var(--muted-foreground)" }}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              id={`alert-email-${workerId}`}
              type="email"
              placeholder="you@example.com"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addEmail();
                }
              }}
            />
            <button
              type="button"
              className="c-vpill shrink-0"
              style={{ ...pillBtn, cursor: "pointer" }}
              onClick={addEmail}
            >
              <Plus className="size-3.5" aria-hidden="true" /> Add
            </button>
          </div>
          <span style={{ ...muted, fontSize: 11.5 }}>
            Must be a workspace member. Press Enter to add each address.
          </span>
        </div>

        {/* Webhook URL */}
        <div className="flex flex-col gap-2">
          <Label htmlFor={`alert-url-${workerId}`} style={{ fontSize: 12.5 }}>
            Webhook URL
          </Label>
          <Input
            id={`alert-url-${workerId}`}
            type="url"
            placeholder="https://hooks.example.com/floom"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={!urlValid}
          />
          {!urlValid && (
            <span style={{ fontSize: 11.5, color: "var(--warning)" }}>
              Enter a valid http(s) URL.
            </span>
          )}
        </div>

        {/* Description (optional) */}
        <div className="flex flex-col gap-2">
          <Label htmlFor={`alert-desc-${workerId}`} style={{ fontSize: 12.5 }}>
            Description <span style={muted}>(optional)</span>
          </Label>
          <Input
            id={`alert-desc-${workerId}`}
            placeholder="e.g. Page on-call on failure"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="c-addbtn"
            style={{ ...pillBtn, cursor: canSave ? "pointer" : "not-allowed", opacity: canSave ? 1 : 0.55 }}
            onClick={() => void save()}
            disabled={!canSave}
          >
            {saving ? "Saving…" : "Save alert"}
          </button>
          {!hasChannel && (
            <span style={{ ...muted, fontSize: 11.5 }}>
              Add a recipient email or a webhook URL.
            </span>
          )}
        </div>
      </div>
    </DetailGroup>
  );
}

// Operations > Limits: spend cap / reliability / runtime / approvals / egress,
// read from the worker.yml manifest (runtime.limits + connection approval flags).
function OpsLimitsPanel({ w }: { w: WorkerSummary }) {
  const [d] = useWorkerDetail(w.id, w.workspace_id);
  if (d === undefined) return <Loading />;
  if (d === null) return <DetailError />;
  const runtime = d.config?.runtime;
  const limits = (runtime?.limits ?? {}) as Record<string, unknown>;
  const lim = (k: string): React.ReactNode => {
    const v = limits[k];
    return v == null || v === "" ? "Not set" : String(v);
  };
  // Cost limits read as currency; perDay marks the daily cap.
  const cost = (k: string, perDay = false): React.ReactNode => {
    const v = limits[k];
    return v == null || v === "" ? "Not set" : `$${v}${perDay ? "/day" : ""}`;
  };
  const connections = d.config?.connections ?? [];
  const approvalConns = connections.filter(
    (c) => typeof c === "object" && c !== null && "mcp" in c && (c as { mcp?: { require_approval?: string } }).mcp?.require_approval === "always",
  ).length;
  const egressTargets = connections
    .map((c) => (typeof c === "string" ? c : (c as { app?: string }).app))
    .filter((s): s is string => Boolean(s));
  return (
    <div>
      <DetailSummary
        items={[
          { key: "per-day", label: "Cap", value: cost("max_cost_usd_per_day", true) },
          { key: "timeout", label: "Timeout", value: lim("timeout_seconds") },
          { key: "retries", label: "Retries", value: lim("max_retries") },
        ]}
      />
      <DetailGroup label="Spend">
        <DetailRow label="Per run" value={cost("max_cost_usd")} />
        <DetailRow label="Per day" value={cost("max_cost_usd_per_day", true)} />
      </DetailGroup>
      <DetailGroup label="Runtime">
        <DetailRow label="Timeout" value={lim("timeout_seconds")} />
        <DetailRow
          label="Engine"
          value={runtimeSummary({ runner: runtime?.runner ?? d.runner ?? w.runner, runtime: runtime?.type ?? w.runtime })}
        />
      </DetailGroup>
      <DetailGroup label="Reliability">
        <DetailRow label="Retries" value={lim("max_retries")} />
      </DetailGroup>
      <DetailGroup label="Approvals">
        <DetailRow
          label="Require approval"
          value={approvalConns > 0 ? `${approvalConns} connection${approvalConns === 1 ? "" : "s"}` : "Never"}
        />
      </DetailGroup>
      <DetailGroup label="Network egress">
        {egressTargets.length > 0 ? (
          <DetailChips items={egressTargets} />
        ) : (
          <DetailEmpty>No connected apps declared.</DetailEmpty>
        )}
      </DetailGroup>
      {/* Preserved proven content: backend-gated worker feedback moderation. */}
      <WorkerFeedbackSection w={w} />
    </div>
  );
}

// Setup: PRIMARY tab hosting the second-row sub-tabs. Reuses .c-dtabs2 /
// .c-dtab2 (the smaller straight-ink underline variant) — NO sidebar.
function SetupTab({ w, onOpenSource }: { w: WorkerSummary; onOpenSource?: () => void }) {
  const [sub, setSub] = useState<SetupSubtab>("Inputs");
  const counts = useSetupSubCounts(w);
  const workspaceHref = useWorkspaceHref();
  return (
    <div className="flex flex-col">
      {/* R9 FIX 2: the Setup second-row tabs sit DIRECTLY under the primary
          tab row, with no framing text and no gap wedged between the two rows.
          The .c-ops-row-flush wrapper breaks out of the c-dbody padding so
          .c-dtabs2 lines up flush beneath .c-dtabs. The "visual editor of
          worker.yml" framing moved INTO the panel content (below both rows). */}
      <div className="c-ops-row-flush">
        <div className="c-dtabs2" role="tablist" aria-label="Setup">
          {SETUP_SUBTABS.map((key) => (
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
      </div>
      {/* Visual-editor-of-worker.yml framing + View-as-YAML deep-link, now in the
          panel body below the rows (not between them). */}
      <div className="c-ops-frame">
        <span>Visual worker editor</span>
        <Link
          href={workspaceHref(`/workers?sel=${encodeURIComponent(w.id)}&tab=Source`)}
          className="ml-auto normal-case"
          style={{ fontSize: 11, letterSpacing: 0 }}
          onClick={(e) => {
            e.preventDefault();
            onOpenSource?.();
          }}
        >
          View as YAML →
        </Link>
      </div>
      <div style={{ paddingTop: 12 }}>
        {sub === "Inputs" && <OpsInputsPanel w={w} />}
        {sub === "Alerts & webhooks" && <OpsAlertsPanel w={w} />}
        {sub === "Triggers" && <TriggersTab w={w} />}
        {sub === "Limits" && <OpsLimitsPanel w={w} />}
      </div>
    </div>
  );
}

/** Small count badges for the Setup sub-tabs, derived from the manifest. */
function useSetupSubCounts(w: WorkerSummary): Partial<Record<SetupSubtab, number>> {
  const [d] = useWorkerDetail(w.id, w.workspace_id);
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
  Setup: SetupTab,
  Source: SourceTab,
  Versions: VersionsTab,
  Brain: BrainTab,
  Tools: ToolsTab,
};

// Each worker tab opts out of the structured register for an accurate reason:
// these are bespoke components (graph, nested editors, file/version viewers,
// run list, async tool allowlist), not synchronous key/value panes.
const WORKER_TAB_REASON: Record<WorkerDetailTab, CustomTabReason> = {
  Overview: "worker-flow",
  Runs: "worker-runs",
  Setup: "worker-setup",
  Source: "file-viewer",
  Versions: "version-history",
  Brain: "brain-editor",
  Tools: "tool-list",
};

/** Developer disclosure: advanced tabs are either visible inline or hidden. */
function DeveloperToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`c-dtab-adv inline-flex items-center gap-1${open ? " open" : ""}`}
      aria-label={open ? "Hide developer tabs" : "Show developer tabs"}
      aria-pressed={open}
      onClick={onToggle}
    >
      Developer
      <ChevronDown className={`size-3.5 transition-transform${open ? " rotate-180" : ""}`} aria-hidden="true" />
    </button>
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
  const workspaceHref = useWorkspaceHref();
  const [d, applyDetail] = useWorkerDetail(w.id, w.workspace_id);
  const [editOpen, setEditOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(w.name);
  const [description, setDescription] = useState(w.description ?? "");

  useEffect(() => {
    if (!editOpen) return;
    setName(d?.name ?? w.name);
    setDescription(d?.description ?? w.description ?? "");
  }, [editOpen, d?.description, d?.name, w.description, w.name]);

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
          style={{ ...pillBtn, cursor: "pointer" }}
          // R9: kill the jarring popup + hard-nav. The Run button routes to the
          // calm inline /run/{worker} page (schema-driven inputs + live
          // output-first run panel), the same standalone runnable surface — no
          // Dialog, no third page. See feedback/round-09/run-detail-real.md.
          onClick={() => router.push(workspaceHref(`/run/${encodeURIComponent(w.id)}`))}
          title={w.enabled === false || (w as WorkerSummary & { paused?: boolean }).paused ? "This worker is paused; it may not run as expected" : undefined}
        >
          Run
        </button>
      )}
      {(canManage || can("share", w) || can("edit", w)) && (
        // Share is the growth lever — promote it to a visible header button
        // instead of burying it in the ⋯ overflow menu. Opens the same Share
        // modal (company access + grants + anonymous public link with revoke).
        <button
          type="button"
          className="c-addbtn"
          style={{ ...pillBtn, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
          onClick={() => setShareOpen(true)}
          title="Share this worker"
        >
          <Share2 className="size-4" />
          Share
        </button>
      )}
      {(canManage || can("edit", w)) && (
        <ActionMenu
          label="More worker actions"
          items={[
            { label: "Edit", icon: <Edit3 className="size-4" />, onSelect: () => setEditOpen(true) },
            // Pause/Resume — gap #6 / #788: hit the real lifecycle endpoints
            // (POST /workers/{id}/pause|/resume). These set enabled AND re-enqueue
            // the schedule, which a raw worker.yml `enabled:` PUT does not do.
            {
              label: w.enabled === false ? "Resume" : "Pause",
              icon: w.enabled === false ? <PlayCircle className="size-4" /> : <PauseCircle className="size-4" />,
              onSelect: () => {
                const pausing = w.enabled !== false;
                const action = pausing ? api.workers.pause : api.workers.resume;
                action(w.id)
                  .then((updated) => {
                    applyDetail(updated);
                    onUpdated({ ...w, enabled: !pausing });
                    toast.success(pausing ? "Worker paused" : "Worker resumed");
                  })
                  .catch((err: Error) => toast.error(err.message || "Could not update worker"));
              },
            },
            // Share was promoted to a visible header button (growth lever) —
            // no longer duplicated here in the ⋯ overflow.
            {
              label: "Duplicate",
              icon: <CopyPlus className="size-4" />,
              onSelect: () => {
                api.workers.duplicate(w.id)
                  .then((created) => {
                    onUpdated(detailToSummary(created));
                    router.push(workspaceHref(`/workers?sel=${encodeURIComponent(created.id)}`));
                    toast.success("Worker duplicated");
                  })
                  .catch((err: Error) => toast.error(err.message || "Could not duplicate worker"));
              },
            },
            {
              label: workerStageKey(w) === "live" ? "Mark as draft" : "Mark as live",
              icon: <RotateCcw className="size-4" />,
              onSelect: () => {
                const next = workerStageKey(w) === "live" ? "draft" : "live";
                api.workers.setStage(w.id, next)
                  .then((updated) => {
                    toast.success(next === "live" ? "Marked as live" : "Marked as draft");
                    onUpdated({ ...w, stage: updated.stage });
                  })
                  .catch((err: Error) => toast.error(err.message || "Could not update stage"));
              },
            },
            {
              label: (w as WorkerSummary & { archived?: boolean }).archived ? "Restore" : "Archive",
              icon: (w as WorkerSummary & { archived?: boolean }).archived
                ? <RotateCcw className="size-4" />
                : <Archive className="size-4" />,
              onSelect: () => {
                const isArchived = (w as WorkerSummary & { archived?: boolean }).archived;
                const action = isArchived ? api.workers.restore : api.workers.archive;
                action(w.id)
                  .then(() => {
                    toast.success(isArchived ? "Worker restored" : "Worker archived");
                    onUpdated({ ...w });
                  })
                  .catch((err: Error) => toast.error(err.message || "Could not update worker"));
              },
            },
            {
              label: "Delete",
              icon: <Trash2 className="size-4" />,
              destructive: true,
              // Replaces window.confirm with the shared ConfirmDialog.
              confirm: {
                title: `Delete "${w.name}"?`,
                body: "This cannot be undone.",
                confirmLabel: "Delete",
                destructive: true,
              },
              onSelect: () => {
                api.workers.delete(w.id)
                  .then(() => {
                    toast.success("Worker deleted");
                    onUpdated({ ...w, _deleted: true } as WorkerSummary & { _deleted?: boolean });
                  })
                  .catch((err: Error) => toast.error(err.message || "Could not delete worker"));
              },
            },
          ]}
        />
      )}

      {/* R9: the Run popup is gone — the Run button now routes to the calm
          inline /run/{worker} page (no Dialog, no hard-nav). The schema-driven
          run form lives there (the same WorkerInputForm), so the worker detail
          no longer carries a duplicate run dialog. */}

      {/* One URL per worker forever (Fede 2026-07-06): a public worker's
          Share modal shows the canonical /@handle/slug permalink as a
          static, non-revocable link (there's nothing to revoke; it's just
          the worker's URL; making the worker private again is the Company
          access control above, and that's what gates the bare URL, not a
          share token). A private/workspace worker keeps the mint/revoke
          state machine, but the URL it returns is now the SAME permalink
          shape with an unguessable ?share=<token> key instead of a separate
          /s/<token> link, so the URL a recipient bookmarks never changes
          even if the worker is later published. */}
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
        publish={
          // #1092: publish/unpublish the /@handle/slug permalink. Cloud-only
          // (the public projection lives on floom.dev) + owner-only (server also
          // enforces 403). The Publish section owns the public permalink for the
          // owner, so publicLink's public branch is suppressed below to avoid
          // showing the URL twice.
          isCloudDeploy() && (d?.permissions?.is_owner ?? false)
            ? {
                isPublic: (d?.visibility ?? w.visibility) === "public",
                permalink: (d ?? w).public_link ?? null,
                onPublish: async () => {
                  const res = await api.workers.publish(w.id);
                  applyDetail(await api.workers.get(w.id));
                  onUpdated({ ...w, visibility: res.visibility, public_link: res.public_link ?? undefined });
                },
                onUnpublish: async () => {
                  const res = await api.workers.unpublish(w.id);
                  applyDetail(await api.workers.get(w.id));
                  onUpdated({ ...w, visibility: res.visibility });
                },
              }
            : undefined
        }
        publicLink={
          isCloudDeploy() && (d?.permissions?.is_owner ?? false) && (d?.visibility ?? w.visibility) === "public"
            ? undefined
            : (d?.visibility ?? w.visibility) === "public"
            ? {
                // create is required by ShareModal's prop type but never
                // invoked at runtime when staticUrl is set (matches the
                // existing app/preview/share/page.tsx pattern).
                create: async () => (d ?? w).public_link ?? "",
                staticUrl: (d ?? w).public_link ?? undefined,
                label: "Permalink",
              }
            : {
                create: async () => (await api.workers.shareLink(w.id)).url,
                // share-loop: show an existing public link (copyable) on open.
                fetchExisting: async () => {
                  const { links } = await api.workers.shareLinks(w.id);
                  return links[0]?.url ?? null;
                },
                revoke: async () => {
                  await api.workers.revokeShareLink(w.id);
                },
                label: "Private link",
              }
        }
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

// ---- Workers empty-state quick start -----------------------------------------

// Two real ways a signed-in user gets a first worker running. Worker creation
// does NOT happen in the dashboard: you either start from a ready-made template
// (the gallery's "Add to workspace" lands a running worker in one click) or set
// up Floom in your coding agent (Claude Code, Codex, Cursor, …) via MCP and ask
// it to build one. The prompt examples are what you'd say to THAT coding agent.
const WORKER_PROMPT_EXAMPLES = [
  "Create a Floom worker that summarizes my latest 5 Gmail emails every hour and sends the summary to Slack.",
  "Create a Floom worker that checks new Linear issues every morning and posts a priority digest to Slack.",
  "Create a Floom worker that watches a Google Sheet for new rows and drafts follow-up emails.",
];

// Template gallery — the primary web activation path. Built from the public site
// origin so a self-hosted instance points at its own gallery and managed Cloud
// points at floom.dev/templates.
const WORKERS_EMPTY_TEMPLATES_URL = `${getPublicSiteOrigin()}/templates`;

function WorkersEmptyQuickStart() {
  return (
    <div className="mt-5 flex w-full max-w-[620px] flex-col items-center gap-6 text-center">
      {/* PRIMARY: start from a template */}
      <div className="flex flex-col items-center gap-3">
        <div>
          <div className="text-sm font-medium text-ink">Start from a template</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a ready-made worker and add it to your workspace. It runs in one click.
          </p>
        </div>
        <Link
          className="c-addbtn"
          href={WORKERS_EMPTY_TEMPLATES_URL}
        >
          Browse templates
        </Link>
      </div>

      <div className="flex w-full items-center gap-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="h-px flex-1 bg-[var(--bg-3)]" />
        or
        <span className="h-px flex-1 bg-[var(--bg-3)]" />
      </div>

      {/* SECONDARY — build one from your coding agent (MCP native path) */}
      <div className="flex w-full flex-col items-center gap-4">
        <div>
          <div className="text-sm font-medium text-ink">Build one from your coding agent</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Install the Floom MCP server in Claude Code, Codex, or Cursor, then ask it to create workers like these:
          </p>
        </div>

        <div className="grid w-full gap-2 text-left">
          {WORKER_PROMPT_EXAMPLES.map((example) => (
            <div
              key={example}
              className="rounded-[var(--radius-button)] bg-[var(--bg-2)] px-3 py-2 font-mono text-[12px] leading-5 text-ink [border:var(--bd-card)]"
            >
              {example}
            </div>
          ))}
        </div>

        <div className="grid gap-1.5 font-mono text-[12px] leading-5 text-muted-foreground">
          <div>npx -y @floomhq/floom mcp install</div>
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          <Link
            className="c-vpill"
            href="/connections/mcp?from_install=workers-empty"
          >
            Install MCP
          </Link>
          <Link
            className="c-vpill"
            href="https://floom.dev/v3/docs/worker-yml"
            target="_blank"
            rel="noreferrer"
          >
            Worker guide
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * A downstream host can inject a top-level view (#1006) and compose
 * `WorkersCollection` without forking the full component. The host decides
 * visibility; the engine stays generic and renders the switcher only when
 * views are supplied.
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
  initialWorkers = [],
  initialWorkersPromise,
  extraViews = [],
}: {
  initialWorkers?: WorkerSummary[];
  // perf: the page streams the first-load fetch as an unawaited promise so the
  // RSC is not blocked behind the backend round-trip. We seed the cache from it
  // in the background (cold start only); a warm cache renders instantly.
  initialWorkersPromise?: Promise<WorkerSummary[]>;
  extraViews?: WorkersExtraView[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const urlWorkspaceId = searchParams.get("workspace_id") || searchParams.get("ws");
  const persistedWorkspaceId = getPersistedActiveWorkspaceId();
  const urlWorkspaceNeedsActivation = Boolean(urlWorkspaceId && urlWorkspaceId !== persistedWorkspaceId);
  const workspaceHref = useWorkspaceHref();
  useStreamedInitialData(
    qk.workers(WORKERS_LIST_QUERY_OPTS),
    urlWorkspaceNeedsActivation ? undefined : initialWorkersPromise,
  );
  // Cache-first workers list (TanStack Query): returning to /workers renders
  // instantly from cache with no skeleton; a slow/failed refetch keeps showing
  // the cached list instead of flashing "Something went wrong". Local `workers`
  // state is kept in sync so the existing optimistic mutation handlers (delete,
  // update, archive) still work.
  const workersQuery = useWorkers(
    WORKERS_LIST_QUERY_OPTS,
    !urlWorkspaceNeedsActivation && initialWorkers.length > 0 ? initialWorkers : undefined,
    !urlWorkspaceNeedsActivation,
  );
  const [workers, setWorkers] = useState<WorkerSummary[]>(initialWorkers);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [canManageWorkers, setCanManageWorkers] = useState(false);
  const [activeView, setActiveView] = useState<string>(WORKERS_VIEW_KEY);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const refreshWorkerSummary = useCallback(
    (detail: WorkerDetail) => {
      const summary = detailToSummary(detail);
      setWorkers((prev) => prev.map((item) => (item.id === summary.id ? { ...item, ...summary } : item)));
      queryClient.setQueryData<WorkerSummary[]>(
        qk.workers(WORKERS_LIST_QUERY_OPTS),
        (prev) => Array.isArray(prev)
          ? prev.map((item) => (item.id === summary.id ? { ...item, ...summary } : item))
          : prev,
      );
    },
    [queryClient],
  );
  // Selecting a tab = navigate to ?sel=<id>&tab=<key>; CollectionView reads the
  // `tab` URL param to drive the active tab. replace() avoids a history entry.
  const openAdvancedAndSelectWorkerTab = useCallback(
    (workerId: string, key: WorkerDetailTab) => {
      if (ADVANCED_DETAIL_TABS.includes(key)) {
        setDeveloperOpen(true);
        safeStorageSet("local", ADVANCED_MODE_STORAGE_KEY, "open");
      }
      router.replace(
        workspaceHref(`/workers?sel=${encodeURIComponent(workerId)}&tab=${encodeURIComponent(key)}`),
      );
    },
    [router, workspaceHref],
  );

  useEffect(() => {
    if (!urlWorkspaceId || urlWorkspaceId === persistedWorkspaceId) return;
    setWorkers([]);
    for (const root of WORKSPACE_SCOPED_QUERY_ROOTS) {
      queryClient.removeQueries({ queryKey: [root] });
    }
    setActiveWorkspaceId(urlWorkspaceId);
  }, [persistedWorkspaceId, queryClient, urlWorkspaceId]);

  useEffect(() => {
    const saved = safeStorageGet("local", ADVANCED_MODE_STORAGE_KEY);
    if (saved === "open") setDeveloperOpen(true);
    else if (saved && ADVANCED_DETAIL_TABS.includes(saved as WorkerDetailTab)) {
      setDeveloperOpen(true);
      safeStorageSet("local", ADVANCED_MODE_STORAGE_KEY, "open");
    }
  }, []);

  useEffect(() => {
    if (workersQuery.data) {
      // Deep-linked workers absent from the cache-first list (#1558) are now
      // hydrated by CollectionView via config.resolveMissing and held in its own
      // merged set, so this effect just mirrors the filtered server list.
      setWorkers(workersQuery.data.filter((w) => !isSystemWorker(w)));
    }
  }, [workersQuery.data]);

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
      // #1446: role lookup falls back to non-admin; log only, no toast (a
      // permission-check failure should not nag the user). The workers list
      // itself is loaded by the cache-first workersQuery (useWorkers) above —
      // no imperative api.workers.list()/setLoading here.
      .catch((err) => logError("Could not load your account role.", err));
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
    invalidSelectionMessage: "Worker not found. It may have been deleted or you may not have access.",
    // #1558: the workers list is cache-first (staleTime 30s) and filters system
    // workers, so a deep-link / Emily "Open worker" to an id not in the loaded
    // list (e.g. one just created) would false-toast "not found". Hydrate it by
    // id and project the detail into a summary; CollectionView merges it so the
    // detail opens with no toast. A genuine miss (null/throw) keeps the toast.
    resolveMissing: async (id) => {
      try {
        const d = await api.workers.get(id);
        cacheWorkerDetail(d, d.workspace_id); // warm the detail-pane cache too
        return detailToSummary(d);
      } catch {
        return null;
      }
    },
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
      // P2-1 (#1565): the header count must agree with the per-card stage badge.
      // The badge is the *stage* axis (Draft vs Live), but this count used the
      // *health* axis (status healthy/ready) — so "5 active" could sit next to a
      // grid where every card shows "Draft". Count live (non-draft) workers on the
      // same axis as the badge so they reconcile: the "live" number equals the
      // number of cards WITHOUT a Draft badge.
      { value: visible.filter((w) => workerStageKey(w) === "live").length, label: "live" },
      {
        value: visible.filter((w) => w.status === "needs_attention" || w.status === "missing_secret").length,
        label: "needs attention",
      },
    ],
    view: { default: "list", grid: true },
    columns: {
      template: "1.9fr 1fr 1fr 130px 40px", // #895: wireframe pageWorkers grid
      headers: ["Worker", "Tools", "Last run", "Status", ""],
    },
    sort: {
      columns: {
        0: { value: (w) => w.name },
        1: { value: (w) => (w.connections ?? []).join(" ") },
        2: {
          value: (w) => {
            const raw = w.recent_stats?.last_run_at ?? w.last_run?.created_at;
            return raw ? Date.parse(raw) : null;
          },
          defaultDirection: "desc",
        },
        3: { value: (w) => workerStatusPill(w)?.label ?? "" },
      },
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
      menu: [
        { label: "Open", icon: <ArrowRight className="size-4" />, onSelect: () => router.push(workspaceHref(`/workers?sel=${encodeURIComponent(w.id)}`)) },
        { label: "Run", icon: <PlayCircle className="size-4" />, onSelect: () => router.push(workspaceHref(`/run/${encodeURIComponent(w.id)}`)) },
        ...(canManageWorkers ? [
          {
            label: "Duplicate",
            icon: <CopyPlus className="size-4" />,
            onSelect: () => {
              api.workers.duplicate(w.id)
                .then((created) => {
                  setWorkers((prev) => [detailToSummary(created), ...prev]);
                  router.push(workspaceHref(`/workers?sel=${encodeURIComponent(created.id)}`));
                  toast.success("Worker duplicated");
                })
                .catch((err: Error) => toast.error(err.message || "Could not duplicate worker"));
            },
          },
          {
            label: (w as WorkerSummary & { archived?: boolean }).archived ? "Restore" : "Archive",
            icon: (w as WorkerSummary & { archived?: boolean }).archived
              ? <RotateCcw className="size-4" />
              : <Archive className="size-4" />,
            onSelect: () => {
              const isArchived = (w as WorkerSummary & { archived?: boolean }).archived;
              const action = isArchived ? api.workers.restore : api.workers.archive;
              action(w.id)
                .then((updated) => {
                  setWorkers((prev) => prev.map((item) => (item.id === w.id ? { ...item, ...detailToSummary(updated) } : item)));
                  toast.success(isArchived ? "Worker restored" : "Worker archived");
                })
                .catch((err: Error) => toast.error(err.message || "Could not update worker"));
            },
          },
          {
            label: "Delete",
            icon: <Trash2 className="size-4" />,
            destructive: true,
            confirm: {
              title: `Delete "${w.name}"?`,
              body: "This cannot be undone.",
              confirmLabel: "Delete",
              destructive: true,
            },
            onSelect: () => {
              api.workers.delete(w.id)
                .then(() => {
                  setWorkers((prev) => prev.filter((item) => item.id !== w.id));
                  toast.success("Worker deleted");
                })
                .catch((err: Error) => toast.error(err.message || "Could not delete worker"));
            },
          },
        ] : []),
      ],
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
    detail: (w, activeTab) => {
      const viewOnly = !canManageWorkers && isViewOnly(w);
      const stage = workerStageKey(w);
      const actions = (
        <>
          <SelectedWorkerSummaryRefresh workerId={w.id} onLoaded={refreshWorkerSummary} />
          <span className={stage === "live" ? "c-pill run" : "c-pill idle"}>
            <span className="dot" aria-hidden="true" />
            {stage === "live" ? "Live" : "Draft"}
          </span>
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
        // Primary tabs stay stable. Developer is an explicit show/hide
        // disclosure; when open, every advanced tab is visible inline.
        tabs: (() => {
          const activeAdvanced = ADVANCED_DETAIL_TABS.includes(activeTab as WorkerDetailTab);
          const showDeveloperTabs = developerOpen || activeAdvanced;
          const visibleKeys: WorkerDetailTab[] = [
            ...BASE_DETAIL_TABS,
            ...(showDeveloperTabs ? ADVANCED_DETAIL_TABS : []),
          ];
          return visibleKeys.map((key) => {
            const Tab = WORKER_TAB_COMPONENT[key];
            return {
              key,
              label: WORKER_DETAIL_TAB_LABEL[key],
              // Each worker tab is a bespoke component (flow graph, nested setup
              // editor, file/version/brain editors, run list, tool allowlist) that
              // loads its own data and owns its own state — not a synchronous
              // key/value pane — so each names an accurate custom reason.
              count: undefined,
              custom: WORKER_TAB_REASON[key],
              render: () => key === "Setup"
                ? <SetupTab w={w} onOpenSource={() => openAdvancedAndSelectWorkerTab(w.id, "Source")} />
                : <Tab w={w} />,
            };
          });
        })(),
        // Developer toggle controls whether advanced tabs are shown inline.
        tabsTrailing: (
          <DeveloperToggle
            open={developerOpen || ADVANCED_DETAIL_TABS.includes(activeTab as WorkerDetailTab)}
            onToggle={() => {
              const next = !(developerOpen || ADVANCED_DETAIL_TABS.includes(activeTab as WorkerDetailTab));
              setDeveloperOpen(next);
              safeStorageSet("local", ADVANCED_MODE_STORAGE_KEY, next ? "open" : "closed");
              if (!next && ADVANCED_DETAIL_TABS.includes(activeTab as WorkerDetailTab)) {
                openAdvancedAndSelectWorkerTab(w.id, "Overview");
              }
            }}
          />
        ),
      };
    },
    states: {
      empty: {
        title: "Create your first worker",
        help: "Workers are YAML-defined automations with code, tools, secrets, memory, and run history.",
        action: <WorkersEmptyQuickStart />,
      },
      filteredEmpty: {
        title: "No workers found",
        help: "Clear the search or filters to see your workers.",
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
const pillBtn: React.CSSProperties = { padding: "6px 11px", fontSize: 12.5 };
