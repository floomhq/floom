"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Play, Plug, Pencil, ClipboardCheck, ChevronRight, ChevronDown,
  File, FolderOpen, Copy, Play as PlayIcon, Code2, Clock, Plug2, ListChecks, Info,
  Trash2, ArrowLeft, BookOpen,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { WorkerAvatar } from "@/components/WorkerAvatar";
import type { WorkerDetail, WorkerInput, WorkerFile, ConnectionItem, TriggerSpec, RunDetail } from "@/lib/types";
import { CsvColumnMapper } from "@/components/csv-column-mapper";
import { FileInputUpload } from "@/components/FileInputUpload";
import { FilesEditor, TriggersEditor, makeTriggerRow, buildTriggersYaml, replaceTriggerBlock } from "@/components/worker-form";
import type { TriggerRow } from "@/components/worker-form";
import { formatRelativeTime } from "@/components/connections/connection-data";
import { formatRelative, formatDuration } from "@/lib/formatters";
import { RunStatusBadge } from "@/components/RunStatus";
import { RunDetailSplitPane } from "@/components/RunDetailSplitPane";
import { useRunStream } from "@/lib/useRunStream";

// ---------------------------------------------------------------------------
// Section types and nav config
// ---------------------------------------------------------------------------

// S31: Federico — "Overview shouldn't even exist. It's the 'other'
// category. ChatGPT would not have this." Killed the Overview tab.
// Run is the default. Narrative (long_description + use_cases +
// how_it_works) moves into a small "About this worker" collapsible
// ABOVE the Run form on the Run tab. Danger zone moves to /edit only
// (already exists there). Tech details + I/O chips dropped (redundant
// with the form fields below + the Run/Source/Edit tabs).
type Section = "about" | "run" | "code" | "triggers" | "connections" | "runs";

const VALID_SECTIONS: Section[] = ["about", "run", "code", "triggers", "connections", "runs"];

function isValidSection(s: string): s is Section {
  return VALID_SECTIONS.includes(s as Section);
}

interface NavItem {
  id: Section;
  label: string;
  icon: React.ReactNode;
}

// S34: Federico — "this page about this worker and run should be different
// tabs. These are completely different content and it's confusing." Restored
// About as a first-class tab (was inlined as <details> on the Run tab in S32).
const NAV_ITEMS: NavItem[] = [
  { id: "about", label: "About", icon: <BookOpen className="w-4 h-4" /> },
  { id: "run", label: "Run", icon: <Play className="w-4 h-4" /> },
  { id: "triggers", label: "Triggers", icon: <Clock className="w-4 h-4" /> },
  { id: "runs", label: "History", icon: <ListChecks className="w-4 h-4" /> },
  { id: "connections", label: "Apps", icon: <Plug2 className="w-4 h-4" /> },
  { id: "code", label: "Source", icon: <Code2 className="w-4 h-4" /> },
];

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function WorkerDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();

  // S22b: Overview is the default landing section.
  // S28: tab state now lives in URL hash (#run, #triggers, etc.) instead of
  // ?section=. Federico request: "all tabs on pages should have # on url slug".
  // Initial section reads from hash on mount; falls back to legacy ?section=
  // for backwards-compat with old links.
  const sectionParam =
    (typeof window !== "undefined" && window.location.hash.replace(/^#/, "")) ||
    (searchParams.get("section") as string) ||
    "";
  // S34: default to "about" so first-time visitors see what the worker does
  // before the Run form. Once they pick a tab via URL hash, that wins. Legacy
  // "#overview" URLs collapse to "about".
  const [activeSection, setActiveSection] = useState<Section>(
    isValidSection(sectionParam) ? sectionParam :
      (sectionParam === "overview" ? "about" : "about")
  );

  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<RunDetail | null>(null);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const activeRunStream = useRunStream(activeRunId);

  // Triggers edit state
  const [triggerRows, setTriggerRows] = useState<TriggerRow[]>([]);
  const [savingTriggers, setSavingTriggers] = useState(false);
  const [triggersDirty, setTriggersDirty] = useState(false);

  const setSection = useCallback((s: Section) => {
    setActiveSection(s);
    // S28: write to hash instead of ?section=. Clean up the legacy query
    // param if present (link migration).
    // S30: pushState (was replaceState) so back/forward navigation walks
    // through tab history. Combined with the hashchange listener below,
    // browser back button now jumps to previous tab.
    const url = new URL(window.location.href);
    url.searchParams.delete("section");
    url.hash = s;
    window.history.pushState(null, "", url.toString());
  }, []);

  // S30: useState initializer only runs once. When the URL hash changes
  // externally (back/forward navigation, deep link, direct paste), the
  // activeSection state stayed at its initial value and the tabs got out
  // of sync with the URL. Listen to hashchange + popstate to re-sync.
  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.replace(/^#/, "");
      if (isValidSection(h) && h !== activeSection) setActiveSection(h);
    };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, [activeSection]);

  // S30: Federico — "has no # slugs for the tabs". On first mount, if the
  // URL has no hash (e.g. user just typed /workers/<id>), write the active
  // section to the hash so the URL is always canonical. Once-only.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.location.hash) {
      const url = new URL(window.location.href);
      url.hash = activeSection;
      window.history.replaceState(null, "", url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setNotFound(false);
      try {
        const [w, conns] = await Promise.all([
          api.workers.get(id as string),
          api.connections.list().catch(() => [] as ConnectionItem[]),
        ]);
        if (cancelled) return;
        setWorker(w);
        setConnections(conns);
        const defaults: Record<string, unknown> = {};
        w.config.inputs.forEach((inp: WorkerInput) => {
          if (inp.default !== undefined) defaults[inp.name] = inp.default;
          else if (inp.type === "boolean") defaults[inp.name] = false;
        });
        setInputs(defaults);
        const files = w.files || [];
        const defaultFile = files.find((f) => f.path === "SKILL.md") || files.find((f) => f.path === "worker.yml") || files[0];
        if (defaultFile) setSelectedFile(defaultFile.path);
        // Init trigger rows from triggers_spec
        const specs: TriggerSpec[] = w.triggers_spec || [];
        if (specs.length > 0) {
          setTriggerRows(specs.map((s) => makeTriggerRow(s)));
        } else if (w.config.trigger) {
          setTriggerRows([makeTriggerRow(w.config.trigger as TriggerSpec)]);
        }
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        const isNotFound =
          msg.includes("404") ||
          /^worker( .+)? not found$/i.test(msg.trim()) ||
          msg.toLowerCase() === "not found";
        if (isNotFound) {
          setNotFound(true);
        }
        // PR S19 (I-32): swallow the toast for non-404 failures. The page
        // renders a "Couldn't load worker / Retry" state for that case;
        // a transient network blip should not also spam a red toast.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [id]);

  async function handleRun() {
    if (!worker) return;
    setRunning(true);
    try {
      const result = await api.workers.run(worker.id, inputs);
      if (!result.run_id) throw new Error("Run ID missing from API response");
      toast.success("Run started");
      setActiveRunId(result.run_id);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to start run");
    } finally {
      setRunning(false);
    }
  }

  const loadActiveRun = useCallback(async () => {
    if (!activeRunId) {
      setActiveRun(null);
      return;
    }
    try {
      const detail = await api.runs.get(activeRunId);
      setActiveRun(detail);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load active run");
    }
  }, [activeRunId]);

  useEffect(() => {
    void loadActiveRun();
  }, [loadActiveRun]);

  useEffect(() => {
    if (activeRunStream.fallbackRun) {
      setActiveRun(activeRunStream.fallbackRun);
    }
  }, [activeRunStream.fallbackRun]);

  useEffect(() => {
    if (activeRunStream.finishedPart) void loadActiveRun();
  }, [activeRunStream.finishedPart, loadActiveRun]);

  function applyExampleInput() {
    if (!worker?.example_input) return;
    const nextInputs: Record<string, unknown> = { ...inputs };
    const fileFieldNames = new Set(
      worker.config.inputs.filter((inp) => inp.type === "file").map((inp) => inp.name)
    );
    let skippedFileFields = false;
    for (const [key, value] of Object.entries(worker.example_input)) {
      if (fileFieldNames.has(key)) {
        if (value == null) {
          // leave file field untouched
        } else {
          skippedFileFields = true;
        }
        continue;
      }
      nextInputs[key] = value;
    }
    setInputs(nextInputs);
    if (skippedFileFields) {
      toast.success("Sample applied. Upload a file for the file field(s)");
    } else {
      toast.success("Sample input applied");
    }
  }

  async function handleSaveTriggers() {
    if (!worker) return;
    setSavingTriggers(true);
    try {
      const triggerYaml = buildTriggersYaml(triggerRows);
      const currentYaml = worker.files?.find((f) => f.path === "worker.yml")?.content || "";
      const newYaml = replaceTriggerBlock(currentYaml, triggerYaml);
      await api.workers.updateFiles(worker.id, [{ path: "worker.yml", content: newYaml }]);
      toast.success("Triggers saved");
      setTriggersDirty(false);
      // Reload worker
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save triggers");
    } finally {
      setSavingTriggers(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Loading / not found states
  // ---------------------------------------------------------------------------

  if (loading) {
    // S29f (F8.6): skeleton now matches the live top-tabs layout
    // (header → tabs row → Run-form card). Was a stale left-rail layout
    // that hadn't been updated since the S22 redesign.
    return (
      <div className="space-y-6">
        {/* Header: name + status pill + description + tags + Edit button */}
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-48 rounded" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-4 w-72 rounded" />
            <div className="flex items-center gap-1.5 pt-1">
              <Skeleton className="h-5 w-16 rounded" />
              <Skeleton className="h-5 w-14 rounded" />
              <Skeleton className="h-5 w-12 rounded" />
            </div>
          </div>
          <Skeleton className="h-8 w-16 shrink-0 rounded" />
        </div>
        {/* Tabs row */}
        <div className="flex gap-2 border-b border-line pb-px">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-8 w-20 rounded" />
          ))}
        </div>
        {/* Run-form card (the default section is "run") */}
        <div className="max-w-xl space-y-4">
          <div className="rounded-md border border-line bg-card p-5 space-y-4">
            <Skeleton className="h-4 w-20 rounded" />
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-24 rounded" />
                <Skeleton className="h-9 w-full rounded" />
              </div>
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-28 rounded" />
                <Skeleton className="h-9 w-full rounded" />
              </div>
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-20 rounded" />
                <Skeleton className="h-24 w-full rounded" />
              </div>
            </div>
            <Skeleton className="h-9 w-full rounded" />
          </div>
        </div>
      </div>
    );
  }

  // PR S19 (I-32): only render "Worker not found" on a CONFIRMED 404 from
  // the backend. A transient network failure should NOT flash the
  // "deleted" copy at first-time users. Other failures (network, 5xx)
  // surface as a generic "Failed to load" with a retry option.
  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
        <p className="text-sm font-medium text-foreground">Worker not found</p>
        <p className="text-xs text-muted-foreground">This worker may have been deleted or the ID is incorrect.</p>
        <Link href="/workers" className="text-xs underline text-muted-foreground hover:text-foreground transition-colors">
          Back to workers
        </Link>
      </div>
    );
  }

  if (!worker) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
        <p className="text-sm font-medium text-foreground">Couldn&apos;t load worker</p>
        <p className="text-xs text-muted-foreground">Something went wrong fetching this worker.</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const requiredConnections: string[] = worker.config.connections ?? [];
  const activeConnectionSlugs = new Set(
    connections.filter((c) => c.status === "active").map((c) => c.app_name.toLowerCase())
  );
  const missingConnections = requiredConnections.filter(
    (slug) => !activeConnectionSlugs.has(slug.toLowerCase())
  );
  const canRun = !running && missingConnections.length === 0;
  const canApplySample = worker.config.inputs.every((inp) => {
    if (!inp.required || inp.type === "file") return true;
    const sampleValue = worker.example_input?.[inp.name];
    return sampleValue !== undefined && sampleValue !== null;
  });
  const requiredSecrets: string[] = worker.config.secrets ?? [];

  // Summary counts for rail
  const runsCount = worker.recent_runs?.length ?? 0;
  const triggersCount = (worker.triggers_spec || []).length || 1;
  const lastRunAt = worker.recent_runs?.[0]?.created_at;
  const triggerSummary = worker.trigger_type || "manual";

  // ---------------------------------------------------------------------------
  // Layout: page header + HORIZONTAL TABS at the top (Federico 2026-05-27 round 2:
  // side rail next to the main app sidebar read as "two sidebars" and he kept
  // saying "no tabs at the top". Switched from side-nav B to shadcn Tabs at top.
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* S34: Federico — "where is the arrow back to workers here?" Restored
          a quiet back-link above the worker title. Cmd-K + sidebar exist but
          a direct one-click "back to list" is what users expect on a detail
          page. */}
      <Link
        href="/workers"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-3.5" />
        <span>Workers</span>
      </Link>
      {/* Worker header. Status dot replaced with a labelled pill so users
          can read the state at a glance. */}
      <div className="flex items-start gap-4">
        {/* S29n: WorkerAvatar — workers feel like employees, not scripts. */}
        <WorkerAvatar seed={worker.id} name={worker.name} size="size-12" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold tracking-tight">{worker.name}</h1>
            <StatusPill status={worker.status} />
            {worker.is_example && (
              <span className="inline-flex items-center rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                Example
              </span>
            )}
          </div>
          {worker.description && (
            <p className="text-muted-foreground text-sm mt-1">{worker.description}</p>
          )}
          {(worker.tags || []).length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {(worker.tags || []).map((tag) => (
                <Badge key={tag} variant="outline" className="text-xs font-normal">{tag}</Badge>
              ))}
            </div>
          )}
          {lastRunAt && (
            <p className="text-xs text-muted-foreground mt-2">Last run {formatRelativeTime(lastRunAt)}</p>
          )}
        </div>
        <Link href={`/workers/${worker.id}/edit`} className="shrink-0">
          <Button variant="outline" size="sm">
            <Pencil className="w-4 h-4 mr-1.5" />
            Edit
          </Button>
        </Link>
      </div>

      {/* Top tabs (shadcn) */}
      <Tabs value={activeSection} onValueChange={(v) => setSection(v as Section)}>
        <TabsList>
          {NAV_ITEMS.map((item) => (
            <TabsTrigger key={item.id} value={item.id}>
              {item.icon}
              <span>{item.label}</span>
              {item.id === "triggers" && triggersCount > 1 && (
                <span className="ml-1 text-[10px] bg-muted-foreground/20 text-muted-foreground rounded px-1">{triggersCount}</span>
              )}
              {item.id === "runs" && runsCount > 0 && (
                <span className="ml-1 text-[10px] bg-muted-foreground/20 text-muted-foreground rounded px-1">{runsCount}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Section content */}
      <div>
        {activeSection === "about" && (
          <AboutSection worker={worker} />
        )}
        {activeSection === "run" && (
          activeRun ? (
            <RunDetailSplitPane
              inline
              run={activeRun}
              parts={activeRunStream.parts}
              streamConnected={activeRunStream.connected}
              streamError={activeRunStream.error}
              onBack={() => {
                setActiveRunId(null);
                setActiveRun(null);
              }}
              onReplay={async () => {
                try {
                  const result = await api.runs.replay(activeRun.worker_id, activeRun.id);
                  if (!result.run_id) throw new Error("Run ID missing from API response");
                  toast.success("Re-running with same inputs");
                  setActiveRunId(result.run_id);
                } catch (e: unknown) {
                  toast.error(`Re-run failed: ${e instanceof Error ? e.message : "unknown"}`);
                }
              }}
              onCancel={async () => {
                if (!confirm("Cancel this run?")) return;
                try {
                  await api.runs.cancel(activeRun.id);
                  toast.success("Cancellation requested");
                  void loadActiveRun();
                } catch (e: unknown) {
                  toast.error(`Cancel failed: ${e instanceof Error ? e.message : "unknown"}`);
                }
              }}
            />
          ) : (
            <RunSection
              worker={worker}
              inputs={inputs}
              fileNames={fileNames}
              running={running}
              missingConnections={missingConnections}
              canRun={canRun}
              canApplySample={canApplySample}
              onInputChange={(name, value) => setInputs((prev) => ({ ...prev, [name]: value }))}
              onFileUploaded={(name, sha256, fileName) => {
                setInputs((prev) => ({ ...prev, [name]: sha256 }));
                setFileNames((prev) => ({ ...prev, [name]: fileName }));
              }}
              onRun={handleRun}
              onApplySample={applyExampleInput}
              onClearInputs={() => {
                const defaults: Record<string, unknown> = {};
                for (const inp of worker.config.inputs) {
                  defaults[inp.name] = inp.default ?? "";
                }
                setInputs(defaults);
                setFileNames({});
              }}
            />
          )
        )}

        {activeSection === "code" && (
          <FilesEditor
            mode="view"
            files={worker.files || []}
            selectedPath={selectedFile}
            onSelect={setSelectedFile}
          />
        )}

        {activeSection === "triggers" && (
          <div className="max-w-2xl">
            <TriggersEditor
              rows={triggerRows}
              onChange={(rows) => {
                setTriggerRows(rows);
                setTriggersDirty(true);
              }}
              connections={connections}
              webhookUrl={worker.webhook_url}
              dirty={triggersDirty}
              saving={savingTriggers}
              onSave={handleSaveTriggers}
              onDiscard={() => {
                const specs: TriggerSpec[] = worker.triggers_spec || [];
                if (specs.length > 0) {
                  setTriggerRows(specs.map((s) => makeTriggerRow(s)));
                } else if (worker.config.trigger) {
                  setTriggerRows([makeTriggerRow(worker.config.trigger as TriggerSpec)]);
                }
                setTriggersDirty(false);
              }}
            />
          </div>
        )}

        {activeSection === "connections" && (
          <ConnectionsSection
            worker={worker}
            requiredConnections={requiredConnections}
            activeConnectionSlugs={activeConnectionSlugs}
            requiredSecrets={requiredSecrets}
          />
        )}

        {activeSection === "runs" && (
          <RunsSection worker={worker} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run section
// ---------------------------------------------------------------------------

// S34: dedicated About tab — long_description + use_cases + how_it_works.
// Federico — "this page about this worker and run should be different tabs.
// These are completely different content and it's confusing."
function AboutSection({ worker }: { worker: WorkerDetail }) {
  const hasContent = !!(
    worker.long_description ||
    (worker.use_cases && worker.use_cases.length > 0) ||
    worker.how_it_works
  );
  if (!hasContent) {
    return (
      <p className="text-sm text-muted-foreground">
        {worker.description || "No description provided."}
      </p>
    );
  }
  return (
    <div className="max-w-2xl space-y-6">
      {worker.long_description && (
        <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">
          {worker.long_description}
        </p>
      )}
      {worker.use_cases && worker.use_cases.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">Use cases</h2>
          <ul className="space-y-1.5">
            {worker.use_cases.map((uc) => (
              <li key={uc} className="flex gap-2.5 text-sm text-foreground leading-relaxed">
                <span className="mt-2 size-1 rounded-full bg-muted-foreground shrink-0" aria-hidden="true" />
                <span>{uc}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {worker.how_it_works && (
        <div className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">How it works</h2>
          <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">
            {worker.how_it_works}
          </p>
        </div>
      )}
    </div>
  );
}

function RunSection({
  worker,
  inputs,
  fileNames,
  running,
  missingConnections,
  canRun,
  canApplySample,
  onInputChange,
  onFileUploaded,
  onRun,
  onApplySample,
  onClearInputs,
}: {
  worker: WorkerDetail;
  inputs: Record<string, unknown>;
  fileNames: Record<string, string>;
  running: boolean;
  missingConnections: string[];
  canRun: boolean;
  canApplySample: boolean;
  onInputChange: (name: string, value: unknown) => void;
  onFileUploaded: (name: string, sha256: string, fileName: string) => void;
  onRun: () => void;
  onApplySample: () => void;
  onClearInputs: () => void;
}) {
  // S29e (F8.10): "Use sample input" was buried under the inputs; users
  // didn't notice it. Moved to a compact action bar at the top with a
  // trash icon to clear all inputs in one click.
  const hasInputs = worker.config.inputs.length > 0;
  const inputsFilled = hasInputs && Object.values(inputs).some(
    (v) => v !== null && v !== undefined && v !== "" && v !== false
  );
  // S29m (ChatGPT-audit P-3): drop Card wrapper; the Run tab is a form, not
  // a distinct surface needing a border. Section heading + form fields sit
  // directly on the page background.
  // S29t (score walk): short inputs (select/string/number/boolean) pair
  // side-by-side; long inputs (textarea/file/csv) span both columns.
  const isLongInput = (inp: WorkerInput) =>
    inp.type === "textarea" || inp.type === "file";
  // S34: About content moved to its own tab (Federico — "different content,
  // different tabs"). Run tab is now form-only.
  return (
    <div className="max-w-xl space-y-6">
      <div className="space-y-4">
        {hasInputs && (worker.example_input || inputsFilled) && (
            <div className="flex items-center gap-2 pb-1">
              {worker.example_input && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 border-line"
                  onClick={onApplySample}
                  disabled={!canApplySample}
                >
                  <ClipboardCheck className="w-3.5 h-3.5 mr-1.5" />
                  Fill with sample input
                </Button>
              )}
              {inputsFilled && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-muted-foreground hover:text-foreground"
                  onClick={onClearInputs}
                  title="Clear all inputs"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  Clear
                </Button>
              )}
            </div>
          )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {worker.config.inputs.map((inp: WorkerInput) => (
            <div key={inp.name} className={`space-y-1.5 ${isLongInput(inp) ? "sm:col-span-2" : ""}`}>
              <Label className="text-sm">
                {inp.label}
                {inp.required && <span className="text-red-500 ml-0.5">*</span>}
              </Label>
              {inp.description && (
                <p className="text-xs text-muted-foreground">{inp.description}</p>
              )}
              {inp.type === "textarea" ? (
                <Textarea
                  placeholder={inp.placeholder}
                  value={(inputs[inp.name] as string) || ""}
                  onChange={(e) => onInputChange(inp.name, e.target.value)}
                  className="min-h-[100px] border-border"
                />
              ) : inp.type === "select" ? (
                <Select
                  value={(inputs[inp.name] as string) || (inp.default as string) || ""}
                  onValueChange={(val) => onInputChange(inp.name, val)}
                >
                  <SelectTrigger className="border-border w-full">
                    <SelectValue placeholder={inp.placeholder || "Select an option"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(inp.options || []).map((opt) => (
                      // S29a: humanize raw enum values for display (e.g.
                      // "branded_markdown" -> "Branded markdown"). Federico
                      // saw the raw enum keys in the dropdown and they read
                      // as developer leftovers. Value sent to API stays raw.
                      <SelectItem key={opt} value={opt}>{humanizeOptionLabel(opt)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : inp.type === "boolean" ? (
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`inp-${inp.name}`}
                    checked={inputs[inp.name] === true || inputs[inp.name] === "true"}
                    onChange={(e) => onInputChange(inp.name, e.target.checked)}
                    className="w-4 h-4 rounded border-border accent-black cursor-pointer"
                  />
                  <label htmlFor={`inp-${inp.name}`} className="text-sm text-muted-foreground cursor-pointer select-none">
                    {inp.placeholder || inp.label}
                  </label>
                </div>
              ) : inp.type === "file" && (inp as WorkerInput & { accept_csv?: boolean }).accept_csv ? (
                <CsvColumnMapper
                  requiredColumns={worker.config.csv_required_columns || []}
                  label={undefined}
                  onMapped={(csv) => onInputChange(inp.name, csv)}
                />
              ) : inp.type === "file" ? (
                <FileInputUpload
                  name={inp.name}
                  value={inputs[inp.name] as string | undefined}
                  fileName={fileNames[inp.name]}
                  accepts={(inp as WorkerInput & { accepts?: string[] }).accepts}
                  maxSizeMb={(inp as WorkerInput & { max_size_mb?: number }).max_size_mb}
                  onUploaded={(sha256, name) => onFileUploaded(inp.name, sha256, name)}
                />
              ) : (
                <Input
                  type={inp.type === "number" ? "number" : "text"}
                  placeholder={inp.placeholder}
                  value={(inputs[inp.name] as string) || ""}
                  onChange={(e) => onInputChange(inp.name, e.target.value)}
                  className="border-border"
                />
              )}
            </div>
          ))}
        </div>

          {worker.config.inputs.length === 0 && (
            <p className="text-sm text-muted-foreground">This worker has no inputs.</p>
          )}

          {missingConnections.length > 0 && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 text-xs text-amber-800">
              <Plug className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Connection required</p>
                <p>
                  Connect{" "}
                  {missingConnections.map((s, i) => (
                    <span key={s}>
                      <span className="font-medium capitalize">{s}</span>
                      {i < missingConnections.length - 1 ? ", " : ""}
                    </span>
                  ))}{" "}
                  in{" "}
                  <Link href="/connections" className="underline hover:text-amber-900">
                    Connections
                  </Link>{" "}
                  before running.
                </p>
              </div>
            </div>
          )}

          <Button onClick={onRun} disabled={!canRun} className="w-full">
            <Play className="w-4 h-4 mr-1.5" />
            {running
              ? "Starting..."
              : missingConnections.length > 0
              ? `Connect ${missingConnections[0]} first`
              : "Run worker"}
          </Button>
      </div>

      {worker.webhook_url && (
        <section className="space-y-3 pt-4 border-t border-line">
          <div>
            <h2 className="text-base font-semibold text-foreground">Webhook</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Send a POST request to this URL to trigger the worker. The token authenticates the request.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Webhook URL</Label>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-muted border border-border rounded px-2 py-1.5 break-all">
                {worker.webhook_url}
              </code>
              <button
                type="button"
                title="Copy URL"
                onClick={() => {
                  navigator.clipboard.writeText(worker.webhook_url!).then(
                    () => toast.success("URL copied"),
                    () => toast.error("Failed to copy"),
                  );
                }}
                className="shrink-0 p-1.5 rounded border border-border bg-card hover:bg-muted transition-colors"
              >
                <Copy className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Example curl</Label>
            <pre className="text-xs font-mono bg-[var(--bg-2)] dark:bg-[#1a1a1a] text-foreground dark:text-[#a8e6a3] border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {`curl -X POST '${worker.webhook_url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"key": "value"}'`}
            </pre>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections section
// ---------------------------------------------------------------------------

function ConnectionsSection({
  worker,
  requiredConnections,
  activeConnectionSlugs,
  requiredSecrets,
}: {
  worker: WorkerDetail;
  requiredConnections: string[];
  activeConnectionSlugs: Set<string>;
  requiredSecrets: string[];
}) {
  // S29m (ChatGPT-audit P-3): drop Card wrappers; render as flat sections
  // matching Overview tab rhythm.
  return (
    <div className="max-w-xl space-y-8">
      {requiredConnections.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">Required integrations</h2>
          <ul className="space-y-2">
            {requiredConnections.map((slug) => {
              const isActive = activeConnectionSlugs.has(slug.toLowerCase());
              return (
                <li key={slug} className="flex items-center justify-between py-2 border-b border-line last:border-0">
                  <span className="text-sm capitalize font-medium">{slug}</span>
                  {isActive ? (
                    <span className="text-xs text-muted-foreground">Active</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs text-amber-600 border-amber-200 bg-amber-50">
                        Missing
                      </Badge>
                      <Link href="/connections">
                        <Button size="sm" variant="outline" className="h-6 text-xs border-line">
                          Connect
                        </Button>
                      </Link>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">This worker requires no integrations.</p>
      )}

      {requiredSecrets.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">Required secrets</h2>
          <ul className="space-y-2">
            {requiredSecrets.map((s) => (
              <li key={s} className="flex items-center justify-between py-2 border-b border-line last:border-0">
                <span className="text-sm font-mono font-medium">{s}</span>
                <Link href="/settings">
                  <Button size="sm" variant="outline" className="h-6 text-xs border-line">
                    Configure
                  </Button>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runs section
// ---------------------------------------------------------------------------

function RunsSection({ worker }: { worker: WorkerDetail }) {
  // S29m (ChatGPT-audit P-3): drop Card wrapper. The History tab IS a list,
  // it doesn't need an extra "Recent runs" titled border.
  return (
    <div className="max-w-2xl space-y-2">
      {worker.recent_runs?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        // S29q: was rendering run.id as BOTH title and font-mono secondary
        // line (duplicate), every row showed a "completed" Badge (decoration
        // — should route through RunStatusBadge which hides for default-success).
        // Now: relative-time title, dot-separated meta (duration · trigger),
        // RunStatusBadge for non-success states only. Matches /runs list rhythm.
        worker.recent_runs?.map((r) => (
          <Link
            key={r.id}
            href={`/runs/${r.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between p-2 hover:bg-muted cursor-pointer transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{formatRelative(r.created_at) || "Unknown time"}</p>
              <p className="text-xs text-muted-foreground">
                {formatDuration(r.duration_ms)} · {(r.trigger_source || "manual")}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <RunStatusBadge status={r.status} />
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
          </Link>
        ))
      )}
    </div>
  );
}



// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------



// S29a: humanize raw enum option keys for display in select dropdowns.
// "branded_markdown" -> "Branded markdown"
// "two_pager"        -> "Two pager"
// "PLAIN_TEXT"       -> "Plain text"
function humanizeOptionLabel(raw: string): string {
  if (!raw) return raw;
  const lower = raw.replace(/[_-]+/g, " ").toLowerCase().trim();
  if (!lower) return raw;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}


// S22b: labelled status pill replaces the size-2 dot indicator (roast P1:
// dot was too subtle, "Weekly Update" 33%-success orange dot blended in
// with healthy green dots).
function StatusPill({ status }: { status: string }) {
  // S29l: quiet by default. Show only states the user must act on.
  if (status === "healthy" || !status) return null;
  const conf: Record<string, { label: string; classes: string }> = {
    needs_attention: {
      label: "Needs attention",
      classes: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
    },
    missing_secret: {
      label: "Missing secret",
      classes: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
    },
    error: {
      label: "Error",
      classes: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
    },
  };
  const { label, classes } = conf[status] ?? { label: status, classes: "bg-muted text-muted-foreground border-border" };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${classes}`}
    >
      <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {label}
    </span>
  );
}
