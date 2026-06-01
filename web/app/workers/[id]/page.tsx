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
  Play, Plug, Pencil, ClipboardCheck, ChevronRight,
  Copy, Code2, Clock, Plug2, ListChecks,
  Trash2, ArrowLeft, BookOpen, Save, X, Archive, ArchiveRestore, MoreVertical,
  Brain as BrainIcon, Settings2, AlignLeft, Plus,
} from "lucide-react";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WorkerIconPills } from "@/components/WorkerIconPills";
import { WorkerAsciiDiagram } from "@/components/WorkerAsciiDiagram";
import type {
  WorkerDetail,
  WorkerInput,
  WorkerOutput,
  WorkerFile,
  ConnectionItem,
  TriggerSpec,
  RunDetail,
  ContextSummary,
  WorkerConnectionSpec,
  WorkerContextSpec,
} from "@/lib/types";
import { CsvColumnMapper } from "@/components/csv-column-mapper";
import { FileInputUpload } from "@/components/FileInputUpload";
import { FilesEditor, TriggersEditor, WorkerMetadataForm, makeTriggerRow, buildTriggersYaml, replaceTriggerBlock } from "@/components/worker-form";
import type { TriggerRow } from "@/components/worker-form";
import type { WorkerMetadataValues } from "@/components/worker-form";
import { formatRelativeTime } from "@/components/connections/connection-data";
import { formatRelative, formatDuration } from "@/lib/formatters";
import { humanizeRunError } from "@/lib/run-format";
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
type Section = "about" | "run" | "settings" | "brain" | "code" | "connections" | "runs";

const VALID_SECTIONS: Section[] = ["about", "run", "settings", "brain", "code", "connections", "runs"];

function isValidSection(s: string): s is Section {
  return VALID_SECTIONS.includes(s as Section);
}

// P2-3: the URL hash must match the visible tab label, not the internal
// Section id. Labels: About / Run / Triggers / History / Connections / Source.
// Internal ids stay stable (runs/connections/code) for back-compat; only the
// hash slug the user sees/links changes.
const SECTION_TO_HASH: Record<Section, string> = {
  about: "about",
  run: "run",
  settings: "settings",
  brain: "brain",
  runs: "history",
  connections: "connections",
  code: "source",
};
const HASH_TO_SECTION: Record<string, Section> = {
  about: "about",
  run: "run",
  configure: "code",      // legacy — configure now lives in Source (form view)
  settings: "settings",
  brain: "brain",
  contexts: "brain",
  context: "brain",
  triggers: "settings",   // legacy — triggers live in Settings
  history: "runs",
  apps: "connections",
  connection: "connections",
  advanced: "code",       // legacy deep-link still works
  source: "code",
  code: "code",
  overview: "about",
  runs: "runs",
  connections: "connections",
};

function hashToSection(h: string): Section | null {
  return HASH_TO_SECTION[h] ?? (isValidSection(h) ? h : null);
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
  { id: "settings", label: "Settings", icon: <Settings2 className="w-4 h-4" /> },
  { id: "brain", label: "Brain", icon: <BrainIcon className="w-4 h-4" /> },
  { id: "runs", label: "History", icon: <ListChecks className="w-4 h-4" /> },
  { id: "connections", label: "Connections", icon: <Plug2 className="w-4 h-4" /> },
  { id: "code", label: "Source", icon: <Code2 className="w-4 h-4" /> },
];

// ---------------------------------------------------------------------------
// Source-file derivation
// ---------------------------------------------------------------------------

// R3: on prod the API returns worker.files = [] for many workers (the source
// dir isn't on disk in that deploy layout), but the source IS present in the
// dedicated content fields (run_py_content / skill_md_content / manifest_yaml).
// Build a WorkerFile[] from those fields so the Source tab actually renders.
import { patchInputDefault, patchRetryBlock, patchNotifyBlock } from "@/lib/yaml-utils";

function deriveSourceFiles(worker: WorkerDetail | null): WorkerFile[] {
  if (!worker) return [];
  if (worker.files && worker.files.length > 0) return worker.files;

  const derived: WorkerFile[] = [];
  const push = (path: string, language: string, content?: string | null) => {
    if (!content) return;
    derived.push({ path, language, content, binary: false, size: content.length });
  };
  push("worker.yml", "yaml", worker.manifest_yaml);
  push("SKILL.md", "markdown", worker.skill_md_content);
  push("run.py", "python", worker.run_py_content ?? worker.run_py);
  return derived;
}

function contextSpecName(spec: WorkerContextSpec): string {
  if (typeof spec === "string") return spec;
  return spec.name;
}

function contextSpecWritable(spec: WorkerContextSpec): boolean {
  return typeof spec === "object" && spec.writeable === true;
}

function connectionSpecApp(spec: WorkerConnectionSpec): string | null {
  if (typeof spec === "string") return spec;
  if ("composio" in spec && spec.composio?.app) return spec.composio.app;
  if ("app" in spec && spec.app) return spec.app;
  return null;
}

function replaceTopLevelYamlBlock(yaml: string, key: string, replacement: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*(?:$|\\[)`).test(line));
  if (start === -1) return `${yaml.trimEnd()}\n\n${replacement}\n`;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_][\w_-]*:\s*/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...replacement.split("\n"), ...lines.slice(end)].join("\n");
}

function patchBrainContexts(yaml: string, contexts: WorkerContextSpec[]): string {
  const block = dumpYaml(
    { contexts: contexts.length > 0 ? contexts : [] },
    { noRefs: true, lineWidth: -1, sortKeys: false },
  ).trimEnd();
  return replaceTopLevelYamlBlock(yaml, "contexts", block);
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function WorkerDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();

  // S42: edit mode lives in ?edit=1 URL param (no separate /edit route).
  const isEditMode = searchParams.get("edit") === "1";

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
  // before the Run form. Once they pick a tab via URL hash, that wins.
  // P2-3: hash slugs (history/apps/source) map to internal section ids.
  const [activeSection, setActiveSection] = useState<Section>(
    hashToSection(sectionParam) ?? "about"
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
  const [brainPacks, setBrainPacks] = useState<ContextSummary[]>([]);
  const [savingBrain, setSavingBrain] = useState<string | null>(null);
  const [_selectedFile, setSelectedFile] = useState<string | null>(null);
  const activeRunStream = useRunStream(activeRunId);

  // Triggers edit state (always editable regardless of edit mode)
  const [triggerRows, setTriggerRows] = useState<TriggerRow[]>([]);
  const [triggersDirty, setTriggersDirty] = useState(false);

  // S42: edit mode — files editor state (Source tab in edit mode)
  const [editFiles, setEditFiles] = useState<{ path: string; content: string }[]>([]);
  const [editFilesOriginal, setEditFilesOriginal] = useState<Record<string, string>>({});
  const [editSelectedPath, setEditSelectedPath] = useState<string>("worker.yml");

  // S42: edit mode — metadata state (About tab in edit mode)
  const [metaValues, setMetaValues] = useState<WorkerMetadataValues>({
    workerId: "",
    name: "",
    description: "",
  });
  const [metaOriginal, setMetaOriginal] = useState<WorkerMetadataValues>({
    workerId: "",
    name: "",
    description: "",
  });

  // S42: saving state
  const [saving, setSaving] = useState(false);

  // Setup defaults: fill in missing defaults for scheduled workers
  const [setupDefaults, setSetupDefaults] = useState<Record<string, string>>({});
  const [savingDefaults, setSavingDefaults] = useState(false);

  // Configure tab state
  const [configDesc, setConfigDesc] = useState("");
  const [configDescOriginal, setConfigDescOriginal] = useState("");
  const [configInputDefaults, setConfigInputDefaults] = useState<Record<string, string>>({});
  const [configSaving, setConfigSaving] = useState(false);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  const [conflictSuggestions, setConflictSuggestions] = useState<import("@/lib/types").WorkerSuggestion[]>([]);
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [pendingSaveAfterConflict, setPendingSaveAfterConflict] = useState(false);

  // Configure tab — retry & notify state
  const [retryEnabled, setRetryEnabled] = useState(false);
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(3);
  const [retryDelaySeconds, setRetryDelaySeconds] = useState(60);
  const [notifyUrl, setNotifyUrl] = useState("");
  const [notifyEmailTo, setNotifyEmailTo] = useState("");
  const [notifyOnFailed, setNotifyOnFailed] = useState(true);
  const [notifyOnCompleted, setNotifyOnCompleted] = useState(false);

  // Source tab — yaml/form toggle (both are editable)
  const [sourceMode, setSourceMode] = useState<"yaml" | "form">("form");

  // Source Form — full editable worker manifest state
  const [formName, setFormName] = useState("");
  const [formInputs, setFormInputs] = useState<WorkerInput[]>([]);
  const [formOutputs, setFormOutputs] = useState<WorkerOutput[]>([]);
  const [formSecrets, setFormSecrets] = useState<string[]>([]);
  const [formConnections, setFormConnections] = useState<string[]>([]);
  const [formAddSecret, setFormAddSecret] = useState("");
  const [formAddConnection, setFormAddConnection] = useState("");

  // P1-C (prove100 2026-05-30): worker actions — Archive (reversible) and
  // Delete (destructive, confirm-gated). The API exposed both DELETE and a
  // /restore counterpart but no UI surfaced either, so generated/test workers
  // could not be removed from the product.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Derived dirty flags
  const filesDirty = editFiles.some((f) => f.content !== (editFilesOriginal[f.path] ?? ""));
  const metaDirty =
    metaValues.name !== metaOriginal.name ||
    metaValues.description !== metaOriginal.description;
  const anyDirty = filesDirty || metaDirty;

  const setSection = useCallback((s: Section) => {
    setActiveSection(s);
    // S28: write to hash instead of ?section=. Clean up the legacy query
    // param if present (link migration).
    // S30: pushState (was replaceState) so back/forward navigation walks
    // through tab history. Combined with the hashchange listener below,
    // browser back button now jumps to previous tab.
    const url = new URL(window.location.href);
    url.searchParams.delete("section");
    url.hash = SECTION_TO_HASH[s];
    window.history.pushState(null, "", url.toString());
  }, []);

  // S30: useState initializer only runs once. When the URL hash changes
  // externally (back/forward navigation, deep link, direct paste), the
  // activeSection state stayed at its initial value and the tabs got out
  // of sync with the URL. Listen to hashchange + popstate to re-sync.
  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.replace(/^#/, "");
      const next = hashToSection(h);
      if (next && next !== activeSection) setActiveSection(next);
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
      url.hash = SECTION_TO_HASH[activeSection];
      window.history.replaceState(null, "", url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    // P1-1: deep-linking /workers/<id> sometimes hit a transient fetch failure
    // (cold proxy / network blip) and flashed "Couldn't load worker — Retry"
    // on a perfectly valid worker. Retry the worker fetch up to 2 times with a
    // short backoff before surfacing the error state. A real 404 (worker not
    // found) is NOT retried — it short-circuits to the not-found state.
    async function fetchWorkerWithRetry(workerId: string): Promise<WorkerDetail> {
      const maxAttempts = 3;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await api.workers.get(workerId);
        } catch (e: unknown) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          const isNotFound =
            msg.includes("404") ||
            /^worker( .+)? not found$/i.test(msg.trim()) ||
            msg.toLowerCase() === "not found";
          if (isNotFound || attempt === maxAttempts) throw e;
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
      throw lastErr;
    }
    async function load() {
      setNotFound(false);
      try {
        const [w, conns, packs] = await Promise.all([
          fetchWorkerWithRetry(id as string),
          api.connections.list().catch(() => [] as ConnectionItem[]),
          api.contexts.list().catch(() => [] as ContextSummary[]),
        ]);
        if (cancelled) return;
        setWorker(w);
        setConnections(conns);
        setBrainPacks(packs);
        const defaults: Record<string, unknown> = {};
        w.config.inputs.forEach((inp: WorkerInput) => {
          if (inp.default !== undefined) defaults[inp.name] = inp.default;
          else if (inp.type === "boolean") defaults[inp.name] = false;
        });
        setInputs(defaults);
        const files = deriveSourceFiles(w);
        const defaultFile = files.find((f) => f.path === "worker.yml") || files.find((f) => f.path === "SKILL.md") || files[0];
        if (defaultFile) setSelectedFile(defaultFile.path);
        // S42: init edit-mode file state
        const editableFiles = files
          .filter((f: WorkerFile) => !f.binary)
          .map((f: WorkerFile) => ({ path: f.path, content: f.content || "" }));
        setEditFiles(editableFiles);
        const snap: Record<string, string> = {};
        for (const f of editableFiles) snap[f.path] = f.content;
        setEditFilesOriginal(snap);
        setEditSelectedPath("worker.yml");
        // S42: init metadata state
        const meta: WorkerMetadataValues = {
          workerId: w.id,
          name: w.name,
          description: w.description || "",
        };
        setMetaValues(meta);
        setMetaOriginal(meta);
        // Init trigger rows from triggers_spec
        const specs: TriggerSpec[] = w.triggers_spec || [];
        if (specs.length > 0) {
          setTriggerRows(specs.map((s) => makeTriggerRow(s)));
        } else if (w.config.trigger) {
          setTriggerRows([makeTriggerRow(w.config.trigger as TriggerSpec)]);
        }
        // Init configure tab state
        const desc = w.description || "";
        setConfigDesc(desc);
        setConfigDescOriginal(desc);
        const inputDefs: Record<string, string> = {};
        (w.config.inputs || []).forEach((inp: WorkerInput) => {
          inputDefs[inp.name] = inp.default !== undefined && inp.default !== null ? String(inp.default) : "";
        });
        setConfigInputDefaults(inputDefs);
        // Init form view state
        setFormName(w.name || "");
        setFormInputs(w.config.inputs || []);
        setFormOutputs(w.config.outputs || []);
        setFormSecrets(w.config.secrets || []);
        setFormConnections((w.config.connections || []).filter((c: unknown) => typeof c === "string") as string[]);
        // Init retry/notify from config
        const retryCfg = (w.config as { retry?: { max_attempts?: number; delay_seconds?: number } }).retry;
        setRetryEnabled(!!retryCfg);
        setRetryMaxAttempts(retryCfg?.max_attempts ?? 3);
        setRetryDelaySeconds(retryCfg?.delay_seconds ?? 60);
        const notifyCfg = (w.config as { notify?: { url?: string; email_to?: string[]; on?: string[] } }).notify;
        setNotifyUrl(notifyCfg?.url ?? "");
        setNotifyEmailTo((notifyCfg?.email_to ?? []).join(", "));
        setNotifyOnFailed(notifyCfg ? (notifyCfg.on ?? ["failed"]).includes("failed") : true);
        setNotifyOnCompleted(notifyCfg ? (notifyCfg.on ?? []).includes("completed") : false);
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

  async function applyExampleInput() {
    if (!worker) return;
    // Prefer example_input from the yaml manifest. Fall back to the sample-input API endpoint.
    let exampleInput = worker.example_input;
    if (!exampleInput) {
      try {
        exampleInput = await api.workers.sampleInput(worker.id);
      } catch {
        toast.error("No sample input available for this worker");
        return;
      }
    }
    if (!exampleInput) {
      toast.error("No sample input available for this worker");
      return;
    }
    const nextInputs: Record<string, unknown> = { ...inputs };
    const nextFileNames: Record<string, string> = { ...fileNames };
    const fileInputsByName = new Map(
      worker.config.inputs.filter((inp) => inp.type === "file").map((inp) => [inp.name, inp])
    );
    // File fields whose sample is INLINE TEXT CONTENT (a string) are synthesized
    // into a real uploaded file so the worker is one-click runnable — no manual
    // upload required (G5 FIX 4). Fields with no usable inline content fall back
    // to the prior behaviour (operator must upload a file).
    const fileUploads: Array<{ name: string; content: string; mediaType: string; ext: string }> = [];
    let unfillableFileFields = false;
    for (const [key, value] of Object.entries(exampleInput)) {
      const fileInp = fileInputsByName.get(key);
      if (fileInp) {
        if (typeof value === "string" && value.trim()) {
          const accepts = (fileInp as WorkerInput & { accepts?: string[] }).accepts ?? [];
          const acceptCsv = (fileInp as WorkerInput & { accept_csv?: boolean }).accept_csv === true;
          // accept_csv inputs are rendered by CsvColumnMapper, which passes the
          // RAW CSV STRING inline as the run value (not an upload hash). Fill
          // that field directly — uploading it would bind the wrong type.
          if (acceptCsv) {
            nextInputs[key] = value;
            continue;
          }
          // Other file inputs upload to a SHA-256 reference. Match the file's
          // declared media type so a CSV-only input gets a text/csv upload (not
          // text/plain). Default to text/plain.
          let mediaType = "text/plain";
          let ext = "txt";
          if (accepts.includes("text/csv")) {
            mediaType = "text/csv";
            ext = "csv";
          } else if (accepts.includes("text/markdown")) {
            mediaType = "text/markdown";
            ext = "md";
          } else if (accepts.includes("application/json")) {
            mediaType = "application/json";
            ext = "json";
          } else if (accepts.length > 0 && !accepts.includes("text/plain")) {
            // Declared accepts that we cannot synthesize as text -> leave to
            // the operator rather than upload a mismatched type.
            unfillableFileFields = true;
            continue;
          }
          fileUploads.push({ name: key, content: value, mediaType, ext });
        } else if (value != null) {
          unfillableFileFields = true;
        }
        continue;
      }
      nextInputs[key] = value;
    }

    // Apply scalar inputs immediately so the form fills even if uploads are slow.
    setInputs(nextInputs);

    let uploadedFileFields = 0;
    let uploadFailed = false;
    for (const { name, content, mediaType, ext } of fileUploads) {
      try {
        const fileName = `sample-${name}.${ext}`;
        const blob = new Blob([content], { type: mediaType });
        const form = new FormData();
        form.append("file", blob, fileName);
        const resp = await fetch("/api/proxy/uploads", { method: "POST", body: form });
        if (!resp.ok) {
          uploadFailed = true;
          continue;
        }
        const parsed = (await resp.json()) as { sha256: string };
        nextInputs[name] = parsed.sha256;
        nextFileNames[name] = fileName;
        uploadedFileFields += 1;
      } catch {
        uploadFailed = true;
      }
    }

    if (uploadedFileFields > 0) {
      setInputs({ ...nextInputs });
      setFileNames(nextFileNames);
    }

    if (uploadFailed) {
      toast.success("Sample applied. Upload a file for the remaining field(s)");
    } else if (unfillableFileFields) {
      toast.success("Sample applied. Upload a file for the file field(s)");
    } else {
      toast.success("Sample input applied");
    }
  }

  // S42: toggle edit mode via URL param
  function enterEditMode() {
    const url = new URL(window.location.href);
    url.searchParams.set("edit", "1");
    router.push(url.toString());
  }

  function exitEditMode(force = false) {
    if (!force && anyDirty && !confirm("Discard unsaved changes?")) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("edit");
    router.push(url.toString());
  }

  // S42: save all edit-mode changes (metadata + files)
  async function handleSave() {
    if (!worker) return;
    // Warn if saving a scheduled worker that still has required inputs without defaults.
    if (incompleteScheduledInputs.length > 0) {
      toast.warning(
        `Scheduled runs will fail: set default values for ${incompleteScheduledInputs.map((i) => i.name).join(", ")} in the setup banner above.`
      );
    }
    setSaving(true);
    try {
      const patchedFiles: { path: string; content: string }[] = [...editFiles];

      // Patch metadata into worker.yml if name/description changed
      if (metaDirty) {
        const ymlFile = patchedFiles.find((f) => f.path === "worker.yml");
        if (ymlFile) {
          let yml = ymlFile.content;
          // Update name field
          yml = yml.replace(/^name:\s*.*/m, `name: ${JSON.stringify(metaValues.name)}`);
          // Update description field
          if (/^description:\s*/m.test(yml)) {
            yml = yml.replace(/^description:\s*.*/m, `description: ${JSON.stringify(metaValues.description || "")}`);
          } else if (metaValues.description) {
            yml = yml.replace(/^name:\s*.*/m, (m) => `${m}\ndescription: ${JSON.stringify(metaValues.description || "")}`);
          }
          patchedFiles[patchedFiles.indexOf(ymlFile)] = { ...ymlFile, content: yml };
        }
      }

      await api.workers.updateFiles(worker.id, patchedFiles);
      toast.success("Worker saved");
      // Reload worker and reset dirty state
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      const updatedFiles = (updated.files || [])
        .filter((f: WorkerFile) => !f.binary)
        .map((f: WorkerFile) => ({ path: f.path, content: f.content || "" }));
      setEditFiles(updatedFiles);
      const newSnap: Record<string, string> = {};
      for (const f of updatedFiles) newSnap[f.path] = f.content;
      setEditFilesOriginal(newSnap);
      const newMeta: WorkerMetadataValues = {
        workerId: updated.id,
        name: updated.name,
        description: updated.description || "",
      };
      setMetaValues(newMeta);
      setMetaOriginal(newMeta);
      // Exit edit mode after save
      const url = new URL(window.location.href);
      url.searchParams.delete("edit");
      router.push(url.toString());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAdvanced() {
    if (!worker) return;
    setSaving(true);
    try {
      await api.workers.updateFiles(worker.id, editFiles);
      toast.success("Worker saved");
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      // Sync editFiles
      const updatedFiles = (updated.files || [])
        .filter((f: WorkerFile) => !f.binary)
        .map((f: WorkerFile) => ({ path: f.path, content: f.content || "" }));
      setEditFiles(updatedFiles);
      const newSnap: Record<string, string> = {};
      for (const f of updatedFiles) newSnap[f.path] = f.content;
      setEditFilesOriginal(newSnap);
      // Sync Configure form state so it reflects YAML changes
      const desc = updated.description || "";
      setConfigDesc(desc);
      setConfigDescOriginal(desc);
      const inputDefs: Record<string, string> = {};
      (updated.config.inputs || []).forEach((inp: WorkerInput) => {
        inputDefs[inp.name] = inp.default !== undefined && inp.default !== null ? String(inp.default) : "";
      });
      setConfigInputDefaults(inputDefs);
      const specs: TriggerSpec[] = updated.triggers_spec || [];
      if (specs.length > 0) {
        setTriggerRows(specs.map((s) => makeTriggerRow(s)));
      } else if (updated.config.trigger) {
        setTriggerRows([makeTriggerRow(updated.config.trigger as TriggerSpec)]);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveDefaults() {
    if (!worker) return;
    setSavingDefaults(true);
    try {
      const currentYml =
        deriveSourceFiles(worker).find((f) => f.path === "worker.yml")?.content ||
        worker.manifest_yaml || "";
      let patched = currentYml;
      for (const [name, value] of Object.entries(setupDefaults)) {
        if (value.trim()) {
          patched = patchInputDefault(patched, name, value.trim());
        }
      }
      await api.workers.updateFiles(worker.id, [{ path: "worker.yml", content: patched }]);
      toast.success("Defaults saved — scheduled runs will now use these values");
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      setSetupDefaults({});
      const updatedFiles = (updated.files || [])
        .filter((f: WorkerFile) => !f.binary)
        .map((f: WorkerFile) => ({ path: f.path, content: f.content || "" }));
      setEditFiles(updatedFiles);
      const newSnap: Record<string, string> = {};
      for (const f of updatedFiles) newSnap[f.path] = f.content;
      setEditFilesOriginal(newSnap);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save defaults");
    } finally {
      setSavingDefaults(false);
    }
  }

  async function handleToggleBrainPack(packName: string) {
    if (!worker || savingBrain) return;
    const currentContexts = worker.config.contexts ?? [];
    const selected = currentContexts.some((spec) => contextSpecName(spec) === packName);
    const nextContexts = selected
      ? currentContexts.filter((spec) => contextSpecName(spec) !== packName)
      : [...currentContexts, packName];

    const currentYml =
      editFiles.find((f) => f.path === "worker.yml")?.content ||
      deriveSourceFiles(worker).find((f) => f.path === "worker.yml")?.content ||
      worker.manifest_yaml ||
      "";

    if (!currentYml.trim()) {
      toast.error("worker.yml is unavailable for this worker");
      return;
    }

    setSavingBrain(packName);
    try {
      const patched = patchBrainContexts(currentYml, nextContexts);
      const sourceFiles =
        editFiles.length > 0
          ? editFiles
          : deriveSourceFiles(worker)
              .filter((f) => !f.binary)
              .map((f) => ({ path: f.path, content: f.content || "" }));
      const nextFiles = sourceFiles.some((f) => f.path === "worker.yml")
        ? sourceFiles.map((f) => (f.path === "worker.yml" ? { ...f, content: patched } : f))
        : [{ path: "worker.yml", content: patched }, ...sourceFiles];

      await api.workers.updateFiles(worker.id, nextFiles);
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      const updatedFiles = deriveSourceFiles(updated)
        .filter((f: WorkerFile) => !f.binary)
        .map((f: WorkerFile) => ({ path: f.path, content: f.content || "" }));
      setEditFiles(updatedFiles);
      const newSnap: Record<string, string> = {};
      for (const f of updatedFiles) newSnap[f.path] = f.content;
      setEditFilesOriginal(newSnap);
      toast.success(selected ? "Brain pack removed" : "Brain pack attached");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update brain packs");
    } finally {
      setSavingBrain(null);
    }
  }

  async function commitConfigureSave() {
    if (!worker) return;
    setConfigSaving(true);
    try {
      const currentYml =
        deriveSourceFiles(worker).find((f) => f.path === "worker.yml")?.content ||
        worker.manifest_yaml || "";

      let patched = currentYml;

      // Patch description
      if (configDesc !== configDescOriginal) {
        patched = patched.replace(
          /^description:\s*.*/m,
          `description: ${JSON.stringify(configDesc)}`
        );
        if (!/^description:/m.test(patched)) {
          patched = patched.replace(/^name:\s*.*/m, (m) => `${m}\ndescription: ${JSON.stringify(configDesc)}`);
        }
      }

      // Patch input defaults
      for (const [name, value] of Object.entries(configInputDefaults)) {
        patched = patchInputDefault(patched, name, value);
      }

      await api.workers.updateFiles(worker.id, [{ path: "worker.yml", content: patched }]);
      toast.success("Worker saved");
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      setConfigDesc(updated.description || "");
      setConfigDescOriginal(updated.description || "");
      const inputDefs: Record<string, string> = {};
      (updated.config.inputs || []).forEach((inp: WorkerInput) => {
        inputDefs[inp.name] = inp.default !== undefined && inp.default !== null ? String(inp.default) : "";
      });
      setConfigInputDefaults(inputDefs);
      const updatedFiles = (updated.files || [])
        .filter((f: WorkerFile) => !f.binary)
        .map((f: WorkerFile) => ({ path: f.path, content: f.content || "" }));
      setEditFiles(updatedFiles);
      const newSnap: Record<string, string> = {};
      for (const f of updatedFiles) newSnap[f.path] = f.content;
      setEditFilesOriginal(newSnap);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setConfigSaving(false);
      setConflictModalOpen(false);
      setPendingSaveAfterConflict(false);
    }
  }

  async function commitSettingsSave() {
    if (!worker) return;
    setConfigSaving(true);
    try {
      const currentYml =
        deriveSourceFiles(worker).find((f) => f.path === "worker.yml")?.content ||
        worker.manifest_yaml || "";

      let patched = currentYml;

      // Patch trigger block if dirty
      if (triggersDirty) {
        const triggerYaml = buildTriggersYaml(triggerRows);
        patched = replaceTriggerBlock(patched, triggerYaml);
      }

      // Patch retry block
      patched = patchRetryBlock(
        patched,
        retryEnabled
          ? { max_attempts: retryMaxAttempts, delay_seconds: retryDelaySeconds }
          : null
      );

      // Patch notify block
      const notifyEvents = [
        ...(notifyOnFailed ? ["failed"] : []),
        ...(notifyOnCompleted ? ["completed"] : []),
      ];
      const notifyEmailList = notifyEmailTo.split(",").map((e) => e.trim()).filter(Boolean);
      const hasNotify = notifyUrl.trim() || notifyEmailList.length > 0;
      patched = patchNotifyBlock(
        patched,
        hasNotify
          ? { url: notifyUrl.trim() || undefined, email_to: notifyEmailList.length ? notifyEmailList : undefined, on: notifyEvents.length ? notifyEvents : ["failed"] }
          : null
      );

      await api.workers.updateFiles(worker.id, [{ path: "worker.yml", content: patched }]);
      toast.success("Settings saved");
      setTriggersDirty(false);
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      const updatedFiles = (updated.files || [])
        .filter((f: WorkerFile) => !f.binary)
        .map((f: WorkerFile) => ({ path: f.path, content: f.content || "" }));
      setEditFiles(updatedFiles);
      const newSnap: Record<string, string> = {};
      for (const f of updatedFiles) newSnap[f.path] = f.content;
      setEditFilesOriginal(newSnap);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setConfigSaving(false);
    }
  }

  // handleSaveConfigure removed — form view uses handleSaveForm; configure tab no longer exists

  async function handleSaveSettings() {
    await commitSettingsSave();
  }

  async function commitFormSave() {
    if (!worker) return;
    setConfigSaving(true);
    try {
      const yamlContent =
        editFiles.find((f) => f.path === "worker.yml")?.content ||
        worker.manifest_yaml || "";
      const parsed = ((loadYaml(yamlContent) || {}) as Record<string, unknown>);

      if (formName.trim()) parsed.name = formName.trim();
      parsed.description = configDesc;

      if (formInputs.length > 0) {
        parsed.inputs = formInputs.map((inp) => {
          const obj: Record<string, unknown> = { name: inp.name };
          if (inp.label) obj.label = inp.label;
          if (inp.type) obj.type = inp.type;
          if (inp.required) obj.required = true;
          if (inp.placeholder) obj.placeholder = inp.placeholder;
          if (inp.description) obj.description = inp.description;
          // Use the current default from the input object itself (user may have edited it inline)
          if (inp.default !== undefined && inp.default !== null && inp.default !== "") {
            obj.default = inp.default;
          }
          return obj;
        });
      }

      if (formOutputs.length > 0) {
        parsed.outputs = formOutputs.map((out) => {
          const obj: Record<string, unknown> = { name: out.name };
          if (out.label) obj.label = out.label;
          if (out.type) obj.type = out.type;
          return obj;
        });
      } else {
        delete parsed.outputs;
      }

      if (formSecrets.length > 0) {
        parsed.secrets = formSecrets;
      } else {
        delete parsed.secrets;
      }

      const nonStringConns = (worker.config.connections || []).filter(
        (c) => typeof c !== "string"
      );
      const allConns = [...formConnections, ...nonStringConns];
      if (allConns.length > 0) {
        parsed.connections = allConns;
      } else {
        delete parsed.connections;
      }

      const newYaml = dumpYaml(parsed, { lineWidth: 120 });
      await api.workers.updateFiles(worker.id, [{ path: "worker.yml", content: newYaml }]);
      toast.success("Worker saved");
      setConfigDescOriginal(configDesc);

      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      setFormName(updated.name || "");
      setFormInputs(updated.config.inputs || []);
      setFormOutputs(updated.config.outputs || []);
      setFormSecrets(updated.config.secrets || []);
      setFormConnections(
        (updated.config.connections || []).filter((c) => typeof c === "string") as string[]
      );
      const updatedFiles = deriveSourceFiles(updated)
        .filter((f: WorkerFile) => !f.binary)
        .map((f: WorkerFile) => ({ path: f.path, content: f.content || "" }));
      setEditFiles(updatedFiles);
      const newSnap: Record<string, string> = {};
      for (const f of updatedFiles) newSnap[f.path] = f.content;
      setEditFilesOriginal(newSnap);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setConfigSaving(false);
      setConflictModalOpen(false);
      setPendingSaveAfterConflict(false);
    }
  }

  async function handleSaveForm() {
    if (!worker) return;
    const descChanged = configDesc.trim() !== configDescOriginal.trim();
    if (descChanged) {
      setCheckingConflicts(true);
      try {
        const result = await api.workers.suggest(worker.id, configDesc.trim());
        if (result.has_conflicts && result.suggestions.length > 0) {
          setConflictSuggestions(result.suggestions);
          setConflictModalOpen(true);
          setPendingSaveAfterConflict(true);
          return;
        }
      } catch {
        // proceed
      } finally {
        setCheckingConflicts(false);
      }
    }
    await commitFormSave();
  }

  // P1-C: archive this worker (reversible). On success route back to the list:
  // the archived worker correctly drops out of the default view and surfaces in
  // the Archived view (which offers Restore). Redirecting avoids relying on the
  // archive response reflecting the just-written manifest state.
  async function handleArchive() {
    if (!worker) return;
    setArchiving(true);
    try {
      await api.workers.archive(worker.id);
      toast.success("Worker archived");
      router.push("/workers");
      // Bust the App Router client cache so the list re-renders fresh instead of
      // the stale RSC payload (otherwise the just-archived worker still shows in
      // All until a hard reload).
      router.refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to archive worker");
      setArchiving(false);
    }
  }

  // P1-C: permanently delete this worker (destructive, confirm-gated), then
  // route back to the list. Idempotent-safe: a 404 means the worker is already
  // gone (e.g. a double-submit), which is still a successful outcome — redirect
  // rather than show an error toast.
  async function handleDelete() {
    if (!worker) return;
    setDeleting(true);
    try {
      await api.workers.delete(worker.id);
      toast.success("Worker deleted");
      router.push("/workers");
      // Bust the App Router client cache so the deleted worker doesn't linger as
      // a ghost in the All list (the stale RSC payload still contains it).
      router.refresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (/\b404\b|not found/i.test(msg)) {
        // Already deleted — treat as success.
        toast.success("Worker deleted");
        router.push("/workers");
        router.refresh();
        return;
      }
      toast.error(msg || "Failed to delete worker");
      setDeleting(false);
      setDeleteOpen(false);
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
        <div className="flex gap-2 border-b border-[var(--border-default)] pb-px">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-8 w-20 rounded" />
          ))}
        </div>
        {/* Run-form card (the default section is "run") */}
        <div className="max-w-xl space-y-4">
          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-5 space-y-4">
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

  const connectionSpecs = worker.config.connections ?? [];
  const requiredConnections: string[] = connectionSpecs
    .map(connectionSpecApp)
    .filter((connection): connection is string => Boolean(connection));
  const configuredMcpConnections = connectionSpecs.flatMap((connection) => {
    if (typeof connection === "string" || !("mcp" in connection) || !connection.mcp) return [];
    return [connection.mcp];
  });
  const activeConnectionSlugs = new Set(
    connections.filter((c) => c.status === "active").map((c) => c.app_name.toLowerCase())
  );
  const missingConnections = requiredConnections.filter(
    (slug) => !activeConnectionSlugs.has(slug.toLowerCase())
  );
  // P2: a paused worker (enabled === false) must NOT offer a live Run button —
  // it would only 409. Treat it like a connection block: disabled + a clear
  // "paused" label so the click is never a dead end.
  const isPaused = worker.enabled === false && !worker.archived;
  const canRun = !running && missingConnections.length === 0 && !isPaused;
  // canApplySample: allowed when the worker declares any input. File-only
  // workers are now fillable too — applyExampleInput synthesizes a real upload
  // from the inline example_input content (G5 FIX 4), so a non-technical user
  // gets a one-click runnable sample. The button no-ops gracefully (toast) when
  // no inline sample exists for a file field.
  const canApplySample = worker.config.inputs.length > 0;
  const requiredSecrets: string[] = worker.config.secrets ?? [];

  // Detect scheduled workers with required inputs that have no default value.
  // Scheduled runs are headless — they can't prompt for inputs at runtime.
  const isScheduled = ["schedule", "cron"].includes(
    (worker.trigger_type || worker.config?.trigger?.type || "").toLowerCase()
  );
  const incompleteScheduledInputs = isScheduled
    ? (worker.config.inputs || []).filter(
        (inp) => inp.required && (inp.default === undefined || inp.default === null || inp.default === "")
      )
    : [];

  // Summary counts for rail
  const runsCount = worker.recent_runs?.length ?? 0;
  const triggersCount = (worker.triggers_spec || []).length || 1;
  const lastRunAt = worker.recent_runs?.[0]?.created_at;
  const _triggerSummary = worker.trigger_type || "manual";

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
      {/* U2 (Federico 2026-05-31): letter-avatar removed. The tool/connection
          icon strip (WorkerIconPills, below) + the title carry identity now —
          no initials circle anywhere. */}
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className={`text-xl font-semibold tracking-tight ${worker.archived ? "text-muted-foreground" : ""}`}>{worker.name}</h1>
            {worker.archived ? (
              <span className="inline-flex items-center gap-1 rounded-[var(--radius-button)] border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                <Archive className="size-2.5" />
                Archived
              </span>
            ) : (
              <StatusPill status={worker.status} />
            )}
          </div>
          {worker.archived && worker.archive_reason && (
            <p className="text-muted-foreground text-xs mt-1 italic">{worker.archive_reason}</p>
          )}
          {worker.description && (
            <p className="text-muted-foreground text-sm mt-1">{worker.description}</p>
          )}
          {/* FIX 1 (Federico 2026-05-29): Langdock-grade icon-pill row near the
              title — input-type glyphs (text/person/web/…) + real brand logos
              for declared connections + a trigger glyph, as squircle pills with
              +N overflow. Same WorkerIconPills as the /workers cards. Hidden in
              edit mode (the metadata form owns that surface). Renders nothing
              when the worker has no inputs/connections/trigger. */}
          {!worker.archived && !isEditMode && (
            <WorkerIconPills
              worker={{
                id: worker.id,
                name: worker.name,
                description: worker.description,
                folder: worker.folder,
                tags: worker.tags,
                connections: (worker.config.connections ?? [])
                  .map(connectionSpecApp)
                  .filter((c): c is string => Boolean(c)),
              }}
              inputs={worker.config.inputs}
              connections={(worker.config.connections ?? [])
                .map(connectionSpecApp)
                .filter((c): c is string => Boolean(c))}
              triggerType={worker.trigger_type || worker.config.trigger?.type}
              size="md"
              max={8}
              className="mt-2.5"
            />
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
        {isEditMode ? (
          <div className="flex items-center gap-2 shrink-0">
            {anyDirty && (
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
            )}
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || !anyDirty}
            >
              <Save className="w-4 h-4 mr-1.5" />
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => exitEditMode()}
            >
              <X className="w-4 h-4 mr-1.5" />
              {anyDirty ? "Discard" : "Done"}
            </Button>
          </div>
        ) : worker.archived ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={async () => {
              try {
                const updated = await api.workers.restore(worker.id);
                setWorker(updated);
                toast.success("Worker restored");
              } catch (e: unknown) {
                toast.error(e instanceof Error ? e.message : "Failed to restore worker");
              }
            }}
          >
            <ArchiveRestore className="w-4 h-4 mr-1.5" />
            Restore
          </Button>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            {/* FIX 2 (Federico 2026-05-29): "Example" tag relocated OFF the
                title row to the quiet top-right cluster next to Edit, so the
                title reads clean. Same treatment as the /workers card chip. */}
            {worker.is_example && (
              <span className="inline-flex items-center rounded-[var(--radius-button)] border border-[var(--line-soft)] bg-[var(--bg-2)] px-1.5 py-0.5 text-[10px] font-normal leading-none text-[var(--ink-mute)]">
                Example
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={enterEditMode}
            >
              <Pencil className="w-4 h-4 mr-1.5" />
              Edit
            </Button>
            {/* P1-C: worker actions (Archive / Delete). Hidden for example
                workers — those are read-only stock workers the backend rejects
                mutating (403), so we don't offer a dead-end control. */}
            {!worker.is_example && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] border border-input bg-background text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                  aria-label="Worker actions"
                >
                  <MoreVertical className="w-4 h-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleArchive} disabled={archiving}>
                    <Archive className="w-4 h-4 mr-2" />
                    {archiving ? "Archiving..." : "Archive"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>

      {/* P1-C: destructive delete confirm. Archive is reversible so it acts
          immediately from the menu; Delete removes the worker and all of its
          runs/logs/artifacts and cannot be undone, so it is gated here. */}
      <Dialog open={deleteOpen} onOpenChange={(o) => !deleting && setDeleteOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {worker.name}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the worker and all of its runs, logs, and
              artifacts. This cannot be undone. To keep it recoverable, archive it
              instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Delete worker"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Conflict resolution modal */}
      <Dialog open={conflictModalOpen} onOpenChange={(o) => { if (!o) { setConflictModalOpen(false); setPendingSaveAfterConflict(false); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Potential conflicts detected</DialogTitle>
            <DialogDescription>
              Your new description may conflict with the current configuration. Review the items below, then choose to save anyway or cancel to fix them first.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
            {conflictSuggestions.map((s, i) => (
              <div key={i} className="rounded-lg border border-border p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-medium text-foreground">{s.field}</span>
                </div>
                <p className="text-xs text-muted-foreground">{s.reason}</p>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <div className="rounded bg-muted/50 px-2 py-1">
                    <p className="text-[10px] text-muted-foreground mb-0.5">Current</p>
                    <p className="text-xs font-mono truncate">{s.current}</p>
                  </div>
                  <div className="rounded bg-muted/50 px-2 py-1">
                    <p className="text-[10px] text-muted-foreground mb-0.5">Suggested</p>
                    <p className="text-xs font-mono truncate">{s.suggested}</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground italic">Apply the suggestion in the Source tab (Form view) or edit the YAML directly.</p>
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => { setConflictModalOpen(false); setPendingSaveAfterConflict(false); }}>
              Cancel — I&apos;ll fix it
            </Button>
            <Button size="sm" onClick={() => { if (pendingSaveAfterConflict) { if (sourceMode === "form") commitFormSave(); else commitConfigureSave(); } }}>
              Save anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Setup banner: shown when a scheduled worker has required inputs with no defaults */}
      {incompleteScheduledInputs.length > 0 && !worker.archived && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <Clock className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                Finish setup to enable scheduled runs
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400">
                This worker runs on a schedule but has required inputs with no default values. Scheduled runs can&apos;t prompt for inputs — set defaults below so they run automatically.
              </p>
            </div>
          </div>
          <div className="space-y-2 pl-7">
            {incompleteScheduledInputs.map((inp) => (
              <div key={inp.name} className="flex items-center gap-2">
                <Label className="text-xs w-40 shrink-0 text-amber-800 dark:text-amber-300 font-mono truncate">{inp.label || inp.name}</Label>
                <Input
                  className="h-7 text-xs flex-1"
                  placeholder={inp.placeholder || `Default for ${inp.name}`}
                  value={setupDefaults[inp.name] ?? ""}
                  onChange={(e) => setSetupDefaults((prev) => ({ ...prev, [inp.name]: e.target.value }))}
                />
              </div>
            ))}
            <Button
              size="sm"
              className="mt-1 h-7 text-xs"
              disabled={savingDefaults || incompleteScheduledInputs.every((inp) => !setupDefaults[inp.name]?.trim())}
              onClick={handleSaveDefaults}
            >
              {savingDefaults ? "Saving..." : "Save defaults"}
            </Button>
          </div>
        </div>
      )}

      {/* Top tabs (shadcn). MOBILE-375: the 6-tab bar (About/Run/Triggers/
          History/Connections/Source) is `inline-flex w-fit whitespace-nowrap` — it
          cannot shrink below its content width and at 375 it forced the whole
          page wider than the viewport (Federico's screenshot: title cut off
          on the left, tabs pushed off-screen, page-level horizontal scroll).
          Wrap the tab bar in a full-width scroll container so the OVERFLOW
          stays inside the strip (it scrolls horizontally within itself) and
          never drives page width. `-mx-4 px-4` lets the scroll area run
          edge-to-edge on mobile; on desktop the list is narrower than the
          container so nothing scrolls and it looks identical. */}
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:px-0">
        <Tabs value={activeSection} onValueChange={(v) => setSection(v as Section)}>
          <TabsList>
            {NAV_ITEMS.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.icon}
                <span>{item.label}</span>
                {item.id === "settings" && triggersCount > 1 && (
                  <span className="ml-1 text-[10px] bg-muted-foreground/20 text-muted-foreground rounded px-1">{triggersCount}</span>
                )}
                {item.id === "runs" && runsCount > 0 && (
                  <span className="ml-1 text-[10px] bg-muted-foreground/20 text-muted-foreground rounded px-1">{runsCount}</span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* Section content */}
      <div>
        {activeSection === "about" && (
          isEditMode ? (
            <div className="max-w-xl">
              <WorkerMetadataForm
                mode="edit"
                values={metaValues}
                onChange={setMetaValues}
              />
            </div>
          ) : (
            <AboutSection worker={worker} />
          )
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

        {activeSection === "settings" && (
          <div className="max-w-2xl space-y-6">
            {/* Triggers */}
            <TriggersEditor
              rows={triggerRows}
              onChange={(rows) => {
                setTriggerRows(rows);
                setTriggersDirty(true);
              }}
              connections={connections}
              webhookUrl={worker.webhook_url}
              dirty={false}
              saving={false}
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

            {/* Retry on failure */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">Retry on failure</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Automatically re-run this worker if a run fails.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={retryEnabled}
                  onClick={() => setRetryEnabled(!retryEnabled)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${retryEnabled ? "bg-foreground" : "bg-muted-foreground/30"}`}
                >
                  <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform shadow ${retryEnabled ? "translate-x-4.5" : "translate-x-0.5"}`} />
                </button>
              </div>
              {retryEnabled && (
                <div className="rounded-lg border border-border divide-y divide-border">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">Max attempts</span>
                      <p className="text-xs text-muted-foreground">Total tries including the first (1–10)</p>
                    </div>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      className="h-7 text-xs w-20 shrink-0"
                      value={retryMaxAttempts}
                      onChange={(e) => setRetryMaxAttempts(Math.min(10, Math.max(1, parseInt(e.target.value) || 3)))}
                    />
                  </div>
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">Delay between retries (seconds)</span>
                      <p className="text-xs text-muted-foreground">Wait time before the next attempt (0–3600)</p>
                    </div>
                    <Input
                      type="number"
                      min={0}
                      max={3600}
                      className="h-7 text-xs w-20 shrink-0"
                      value={retryDelaySeconds}
                      onChange={(e) => setRetryDelaySeconds(Math.min(3600, Math.max(0, parseInt(e.target.value) || 60)))}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Notifications */}
            <div className="space-y-3">
              <div>
                <Label className="text-sm font-medium">Notifications</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Post to a webhook when runs complete or fail. Works with Slack, Discord, Zapier, and any HTTP endpoint.</p>
              </div>
              <Input
                type="url"
                className="text-sm"
                placeholder="https://hooks.example.com/run-events"
                value={notifyUrl}
                onChange={(e) => setNotifyUrl(e.target.value)}
              />
              {notifyUrl.trim() && (
                <div className="flex items-center gap-4">
                  <span className="text-xs text-muted-foreground">Notify on:</span>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none text-sm">
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={notifyOnFailed}
                      onChange={(e) => setNotifyOnFailed(e.target.checked)}
                    />
                    <span className="text-sm">Failure</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none text-sm">
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={notifyOnCompleted}
                      onChange={(e) => setNotifyOnCompleted(e.target.checked)}
                    />
                    <span className="text-sm">Success</span>
                  </label>
                </div>
              )}
            </div>

            {/* Save */}
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={handleSaveSettings} disabled={configSaving}>
                {configSaving ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </div>
        )}

        {activeSection === "code" && (
          <div className="space-y-3">
            {/* YAML / Form toggle */}
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {sourceMode === "yaml" ? "Edit the raw worker manifest directly." : "Edit worker settings as a form."}
              </p>
              <div className="flex items-center rounded-md border border-border overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setSourceMode("yaml")}
                  className={`flex items-center gap-1 px-2.5 py-1 transition-colors ${sourceMode === "yaml" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Code2 className="size-3" />
                  YAML
                </button>
                <button
                  type="button"
                  onClick={() => setSourceMode("form")}
                  className={`flex items-center gap-1 px-2.5 py-1 transition-colors ${sourceMode === "form" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <AlignLeft className="size-3" />
                  Form
                </button>
              </div>
            </div>

            {sourceMode === "yaml" && (
              <>
                <FilesEditor
                  mode="edit"
                  files={editFiles}
                  selectedPath={editSelectedPath}
                  onSelect={setEditSelectedPath}
                  onSelectedPathChange={setEditSelectedPath}
                  onChange={setEditFiles}
                />
                <div className="flex items-center gap-3 pt-1">
                  <Button size="sm" onClick={handleSaveAdvanced} disabled={saving || !filesDirty}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  {filesDirty && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditFiles(
                          Object.entries(editFilesOriginal).map(([path, content]) => ({ path, content }))
                        );
                      }}
                      disabled={saving}
                    >
                      Discard
                    </Button>
                  )}
                  {filesDirty && (
                    <span className="text-xs text-muted-foreground">Unsaved changes</span>
                  )}
                </div>
              </>
            )}

            {sourceMode === "form" && (
              <div className="max-w-2xl space-y-6 pt-1">
                {/* Name */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Name</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      className="text-sm flex-1"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="Worker name"
                    />
                    <span className="text-xs text-muted-foreground font-mono shrink-0">{worker.id}</span>
                  </div>
                </div>

                {/* Description */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Description</Label>
                  <p className="text-xs text-muted-foreground">Changing this checks for conflicts with the worker&apos;s configuration.</p>
                  <Textarea
                    rows={3}
                    value={configDesc}
                    onChange={(e) => setConfigDesc(e.target.value)}
                    placeholder="Describe what this worker does…"
                    className="text-sm resize-none"
                  />
                </div>

                {/* Inputs */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-sm font-medium">Inputs</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">Defaults are used when the worker runs on a schedule or without manual input.</p>
                    </div>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                      onClick={() =>
                        setFormInputs((prev) => [
                          ...prev,
                          { name: `input_${prev.length + 1}`, label: "", type: "text", required: false },
                        ])
                      }
                    >
                      <Plus className="size-3" /> Add input
                    </button>
                  </div>
                  {formInputs.length > 0 && (
                    <div className="rounded-lg border border-border divide-y divide-border">
                      {formInputs.map((inp, idx) => (
                        <div key={inp.name + idx} className="px-4 py-3 space-y-2.5">
                          {/* Row 1: label, type, required, remove */}
                          <div className="flex items-center gap-2">
                            <Input
                              className="h-7 text-xs flex-1 min-w-0"
                              placeholder="Label"
                              value={inp.label || ""}
                              onChange={(e) =>
                                setFormInputs((prev) =>
                                  prev.map((p, i) => i === idx ? { ...p, label: e.target.value } : p)
                                )
                              }
                            />
                            <Select
                              value={inp.type || "text"}
                              onValueChange={(v) =>
                                setFormInputs((prev) =>
                                  prev.map((p, i) => i === idx ? { ...p, type: v || "text" } : p)
                                )
                              }
                            >
                              <SelectTrigger className="h-7 text-xs w-28 shrink-0">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {["text", "textarea", "number", "file", "select"].map((t) => (
                                  <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={!!inp.required}
                              title="Toggle required"
                              onClick={() =>
                                setFormInputs((prev) =>
                                  prev.map((p, i) => i === idx ? { ...p, required: !p.required } : p)
                                )
                              }
                              className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${inp.required ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground"}`}
                            >
                              required
                            </button>
                            <button
                              type="button"
                              onClick={() => setFormInputs((prev) => prev.filter((_, i) => i !== idx))}
                              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                            >
                              <X className="size-3.5" />
                            </button>
                          </div>
                          {/* Row 2: key name (read-only) + placeholder */}
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground w-14 shrink-0">Key</span>
                            <span className="text-xs font-mono text-muted-foreground bg-muted border border-border rounded px-2 h-7 flex items-center w-36 shrink-0 truncate">{inp.name}</span>
                            <span className="text-xs text-muted-foreground w-20 shrink-0 text-right">Placeholder</span>
                            <Input
                              className="h-7 text-xs flex-1"
                              placeholder="Hint shown to user"
                              value={inp.placeholder || ""}
                              onChange={(e) =>
                                setFormInputs((prev) =>
                                  prev.map((p, i) => i === idx ? { ...p, placeholder: e.target.value } : p)
                                )
                              }
                            />
                          </div>
                          {/* Row 3: default */}
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground w-14 shrink-0">Default</span>
                            <Input
                              className="h-7 text-xs flex-1"
                              placeholder="No default — user must provide at runtime"
                              value={inp.default !== undefined && inp.default !== null ? String(inp.default) : ""}
                              onChange={(e) =>
                                setFormInputs((prev) =>
                                  prev.map((p, i) => i === idx ? { ...p, default: e.target.value } : p)
                                )
                              }
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {formInputs.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">No inputs defined. Click &quot;Add input&quot; to add one.</p>
                  )}
                </div>

                {/* Advanced collapsible — outputs, connections, secrets */}
                <Collapsible>
                  <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors select-none">
                    <ChevronRight className="size-3 transition-transform [[data-state=open]_&]:rotate-90" />
                    Advanced
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-6 pt-4">
                    {/* Outputs */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">Outputs</Label>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                          onClick={() =>
                            setFormOutputs((prev) => [
                              ...prev,
                              { name: `output_${prev.length + 1}`, label: "", type: "text" },
                            ])
                          }
                        >
                          <Plus className="size-3" /> Add output
                        </button>
                      </div>
                      {formOutputs.length > 0 ? (
                        <div className="rounded-lg border border-border divide-y divide-border">
                          {formOutputs.map((out, idx) => (
                            <div key={out.name + idx} className="flex items-center gap-2 px-4 py-2.5">
                              <Input
                                className="h-7 text-xs flex-1"
                                placeholder="Label"
                                value={out.label || ""}
                                onChange={(e) =>
                                  setFormOutputs((prev) =>
                                    prev.map((p, i) => i === idx ? { ...p, label: e.target.value } : p)
                                  )
                                }
                              />
                              <Select
                              value={out.type || "text"}
                              onValueChange={(v) =>
                                setFormOutputs((prev) =>
                                  prev.map((p, i) => i === idx ? { ...p, type: v || "text" } : p)
                                )
                              }
                              >
                                <SelectTrigger className="h-7 text-xs w-28 shrink-0">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {["text", "json", "file", "markdown", "number"].map((t) => (
                                    <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <span className="text-xs font-mono text-muted-foreground bg-muted border border-border rounded px-2 h-7 flex items-center w-32 shrink-0 truncate">{out.name}</span>
                              <button
                                type="button"
                                onClick={() => setFormOutputs((prev) => prev.filter((_, i) => i !== idx))}
                                className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                              >
                                <X className="size-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">No outputs defined.</p>
                      )}
                    </div>

                    {/* Connections */}
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Connections required</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">Composio app slugs this worker needs (e.g. <code className="font-mono">slack</code>, <code className="font-mono">gmail</code>).</p>
                      <div className="flex flex-wrap gap-1.5">
                        {formConnections.map((slug, idx) => (
                          <span key={slug + idx} className="inline-flex items-center gap-1 text-xs font-mono bg-muted border border-border rounded px-2 py-1">
                            {slug}
                            <button type="button" onClick={() => setFormConnections((prev) => prev.filter((_, i) => i !== idx))} className="text-muted-foreground hover:text-foreground ml-0.5"><X className="size-2.5" /></button>
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-7 text-xs font-mono w-40"
                          placeholder="slack"
                          value={formAddConnection}
                          onChange={(e) => setFormAddConnection(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && formAddConnection.trim()) {
                              setFormConnections((prev) => [...prev, formAddConnection.trim()]);
                              setFormAddConnection("");
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => {
                            if (formAddConnection.trim()) {
                              setFormConnections((prev) => [...prev, formAddConnection.trim()]);
                              setFormAddConnection("");
                            }
                          }}
                        >
                          Add
                        </button>
                      </div>
                    </div>

                    {/* Secrets */}
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">Secrets required</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">Environment variable names this worker reads (e.g. <code className="font-mono">API_KEY</code>).</p>
                      <div className="flex flex-wrap gap-1.5">
                        {formSecrets.map((s, idx) => (
                          <span key={s + idx} className="inline-flex items-center gap-1 text-xs font-mono bg-muted border border-border rounded px-2 py-1">
                            {s}
                            <button type="button" onClick={() => setFormSecrets((prev) => prev.filter((_, i) => i !== idx))} className="text-muted-foreground hover:text-foreground ml-0.5"><X className="size-2.5" /></button>
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-7 text-xs font-mono w-40"
                          placeholder="API_KEY"
                          value={formAddSecret}
                          onChange={(e) => setFormAddSecret(e.target.value.toUpperCase())}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && formAddSecret.trim()) {
                              setFormSecrets((prev) => [...prev, formAddSecret.trim()]);
                              setFormAddSecret("");
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => {
                            if (formAddSecret.trim()) {
                              setFormSecrets((prev) => [...prev, formAddSecret.trim()]);
                              setFormAddSecret("");
                            }
                          }}
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                {/* Save */}
                <div className="flex items-center gap-3 pt-1">
                  <Button
                    size="sm"
                    onClick={handleSaveForm}
                    disabled={configSaving || checkingConflicts}
                  >
                    {checkingConflicts ? "Checking…" : configSaving ? "Saving…" : "Save"}
                  </Button>
                  {configDesc !== configDescOriginal && (
                    <span className="text-xs text-muted-foreground">Description changed — conflicts will be checked on save</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {activeSection === "connections" && (
          <ConnectionsSection
            worker={worker}
            connections={connections}
            requiredConnections={requiredConnections}
            configuredMcpConnections={configuredMcpConnections}
            activeConnectionSlugs={activeConnectionSlugs}
            requiredSecrets={requiredSecrets}
          />
        )}

        {activeSection === "brain" && (
          <BrainSection
            worker={worker}
            brainPacks={brainPacks}
            savingBrain={savingBrain}
            onToggleBrainPack={handleToggleBrainPack}
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
  // FIX (Federico 2026-05-29): polished box-drawing flow diagram of the
  // worker's pipeline (inputs → worker → outputs + connection logos). Built
  // deterministically from the config; renders for every worker (handles
  // 0-input / 0-output / 0-connection gracefully).
  const diagram = (
    <WorkerAsciiDiagram
      workerName={worker.name}
      worker={{
        id: worker.id,
        name: worker.name,
        description: worker.description,
        folder: worker.folder,
        tags: worker.tags,
        connections: (worker.config.connections ?? [])
                  .map(connectionSpecApp)
                  .filter((c): c is string => Boolean(c)),
      }}
      inputs={worker.config.inputs}
      outputs={worker.config.outputs}
      connections={(worker.config.connections ?? [])
                .map(connectionSpecApp)
                .filter((c): c is string => Boolean(c))}
      triggerType={worker.trigger_type || worker.config.trigger?.type}
    />
  );
  if (!hasContent) {
    return (
      <div className="max-w-2xl space-y-6">
        {diagram}
        <p className="text-sm text-muted-foreground">
          {worker.description || "No description provided."}
        </p>
      </div>
    );
  }
  return (
    <div className="max-w-2xl space-y-6">
      {diagram}
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
  // P2: a paused worker offers no live Run — the button is disabled with a
  // clear "turn on to run" label instead of a dead-end click that only 409s.
  const isPaused = worker.enabled === false && !worker.archived;
  const inputsFilled = hasInputs && Object.values(inputs).some(
    (v) => v !== null && v !== undefined && v !== "" && v !== false
  );
  // S29m (ChatGPT-audit P-3): drop Card wrapper; the Run tab is a form, not
  // a distinct surface needing a border. Section heading + form fields sit
  // directly on the page background.
  // P2-2: free-form text fields ("Enrichment instruction", "Raw notes",
  // "Job brief", "Role summary", etc.) render as a wrapping textarea, not a
  // single-line input that truncates. Heuristic on the field name/label since
  // the worker manifest marks them type:"text". Short text fields (location,
  // search query) stay single-line.
  const MULTILINE_HINT = /(instruction|brief|notes?|summary|prompt|message|context|description|details|jd|paste|body|content)/i;
  const isMultilineText = (inp: WorkerInput) =>
    (inp.type === "text" || inp.type === "string") &&
    (MULTILINE_HINT.test(inp.name) || MULTILINE_HINT.test(inp.label || ""));
  // S29t (score walk): short inputs (select/string/number/boolean) pair
  // side-by-side; long inputs (textarea/file/csv/multiline) span both columns.
  const isLongInput = (inp: WorkerInput) =>
    inp.type === "textarea" || inp.type === "file" || isMultilineText(inp);
  // S34: About content moved to its own tab (Federico — "different content,
  // different tabs"). Run tab is now form-only.
  return (
    <div className="max-w-xl space-y-6">
      <div className="space-y-4">
        {hasInputs && (canApplySample || inputsFilled) && (
            <div className="flex items-center gap-2 pb-1">
              {canApplySample && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 border-line"
                  onClick={onApplySample}
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
              {inp.type === "textarea" || isMultilineText(inp) ? (
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
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 text-xs text-amber-800 rounded-[var(--radius-button)]">
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
              : isPaused
              ? "Paused — turn on to run"
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
              <code className="flex-1 text-xs font-mono bg-muted border border-border rounded-[var(--radius-button)] px-2 py-1.5 break-all">
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
                className="shrink-0 p-1.5 rounded-[var(--radius-button)] border border-border bg-card hover:bg-muted transition-colors"
              >
                <Copy className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Example curl</Label>
            <pre className="text-xs font-mono bg-[var(--bg-2)] dark:bg-[#1a1a1a] text-foreground dark:text-[#a8e6a3] border border-line rounded-[var(--radius-button)] p-2 overflow-x-auto whitespace-pre-wrap">
              {`curl -X POST '${worker.webhook_url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"key": "value"}'`}
            </pre>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brain section
// ---------------------------------------------------------------------------

function BrainSection({
  worker,
  brainPacks,
  savingBrain,
  onToggleBrainPack,
}: {
  worker: WorkerDetail;
  brainPacks: ContextSummary[];
  savingBrain: string | null;
  onToggleBrainPack: (name: string) => void;
}) {
  const selectedSpecs = worker.config.contexts ?? [];
  const selectedNames = new Set(selectedSpecs.map(contextSpecName));
  const knownPackNames = new Set(brainPacks.map((pack) => pack.name));
  const missingSelectedPacks = selectedSpecs
    .map(contextSpecName)
    .filter((name) => name && !knownPackNames.has(name));

  const sortedPacks = [...brainPacks].sort((a, b) => {
    const aSelected = selectedNames.has(a.name) ? 0 : 1;
    const bSelected = selectedNames.has(b.name) ? 0 : 1;
    if (aSelected !== bSelected) return aSelected - bSelected;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Brain packs</h2>
          <p className="text-sm text-muted-foreground">
            {selectedNames.size} attached to this worker.
          </p>
        </div>
        <Link href="/brain">
          <Button size="sm" variant="outline">
            Open Brain
          </Button>
        </Link>
      </div>

      {missingSelectedPacks.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 px-3 py-2">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Missing packs in worker.yml: {missingSelectedPacks.join(", ")}
          </p>
        </div>
      )}

      {sortedPacks.length === 0 ? (
        <div className="rounded-[var(--radius-button)] border border-line bg-card p-4">
          <p className="text-sm text-muted-foreground">No brain packs available.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-button)] border border-line bg-card">
          {sortedPacks.map((pack) => {
            const attached = selectedNames.has(pack.name);
            const selectedSpec = selectedSpecs.find((spec) => contextSpecName(spec) === pack.name);
            const writableMount = selectedSpec ? contextSpecWritable(selectedSpec) : false;
            return (
              <div
                key={pack.name}
                className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] border border-line bg-[var(--paper)]">
                    <BrainIcon className="size-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{pack.name}</span>
                      {attached && (
                        <Badge variant="outline" className="border-line text-xs text-muted-foreground">
                          Attached
                        </Badge>
                      )}
                      {pack.system || pack.read_only ? (
                        <Badge variant="outline" className="border-line text-xs text-muted-foreground">
                          Read-only
                        </Badge>
                      ) : null}
                      {writableMount && (
                        <Badge variant="outline" className="border-line text-xs text-muted-foreground">
                          Writable mount
                        </Badge>
                      )}
                    </div>
                    {pack.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{pack.description}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {pack.file_count} {pack.file_count === 1 ? "file" : "files"}
                      {pack.worker_count !== undefined ? ` · ${pack.worker_count} workers` : ""}
                      {pack.updated_at ? ` · Updated ${formatRelative(pack.updated_at)}` : ""}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={attached ? "outline" : "default"}
                  onClick={() => onToggleBrainPack(pack.name)}
                  disabled={Boolean(savingBrain)}
                  className="shrink-0"
                >
                  {savingBrain === pack.name ? "Saving…" : attached ? "Remove" : "Attach"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections section
// ---------------------------------------------------------------------------

function ConnectionsSection({
  worker,
  connections,
  requiredConnections,
  configuredMcpConnections,
  activeConnectionSlugs,
  requiredSecrets,
}: {
  worker: WorkerDetail;
  connections: ConnectionItem[];
  requiredConnections: string[];
  configuredMcpConnections: {
    label: string;
    url: string;
    auth?: string | null;
    allowed_tools?: string[] | null;
  }[];
  activeConnectionSlugs: Set<string>;
  requiredSecrets: string[];
}) {
  // S29m (ChatGPT-audit P-3): drop Card wrappers; render as flat sections
  // matching Overview tab rhythm.
  return (
    <div className="max-w-xl space-y-8">
      {requiredConnections.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">Required connections</h2>
          <ul className="space-y-2">
            {requiredConnections.map((slug) => {
              const slugKey = slug.toLowerCase();
              const appConnections = connections.filter(
                (connection) =>
                  connection.kind !== "mcp" &&
                  connection.app_name.toLowerCase() === slugKey,
              );
              const activeConnections = appConnections.filter(
                (connection) => connection.status === "active",
              );
              const isActive = activeConnectionSlugs.has(slugKey);
              const connectionLabel = activeConnections
                .map((connection) => connection.display_name || connection.account_label)
                .filter(Boolean)
                .join(", ");
              const latestStatus = appConnections[0]?.status;
              return (
                <li key={slug} className="flex items-center justify-between py-2 border-b border-line last:border-0">
                  <div className="min-w-0">
                    <span className="block text-sm capitalize font-medium">{slug}</span>
                    {connectionLabel ? (
                      <span className="block truncate text-xs text-muted-foreground">{connectionLabel}</span>
                    ) : latestStatus ? (
                      <span className="block truncate text-xs text-muted-foreground">Status: {latestStatus}</span>
                    ) : null}
                  </div>
                  {isActive ? (
                    <Badge variant="outline" className="text-xs border-line text-muted-foreground">
                      Active
                    </Badge>
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
        <p className="text-sm text-muted-foreground">This worker requires no connections.</p>
      )}

      {configuredMcpConnections.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">MCP servers</h2>
          <ul className="space-y-2">
            {configuredMcpConnections.map((connection) => (
              <li key={`${connection.label}:${connection.url}`} className="py-2 border-b border-line last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">{connection.label}</span>
                  {connection.auth ? (
                    <span className="text-xs text-muted-foreground">{connection.auth}</span>
                  ) : null}
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{connection.url}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {requiredSecrets.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">Required secrets</h2>
          <ul className="space-y-2">
            {requiredSecrets.map((s) => (
              <li key={s} className="flex items-center justify-between py-2 border-b border-line last:border-0">
                <span className="text-sm font-mono font-medium">{s}</span>
                <Link href="/connections/secrets">
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
  // Federico USR 288 ("history is a bit weird formatting-wise"): wrap rows in
  // the same warm card chrome the /runs page uses, drop max-w-2xl so it fits
  // the page width, surface failure cause inline (matches /runs row format).
  const runs = worker.recent_runs ?? [];
  if (runs.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 text-sm text-muted-foreground">
        No runs yet.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden divide-y divide-[var(--border-default)]">
      {runs.map((r) => (
        <Link
          key={r.id}
          href={`/runs/${r.id}`}
          className="flex items-center justify-between gap-4 p-3 hover:bg-[var(--active-nav-bg)] transition-colors"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{formatRelative(r.created_at) || "Unknown time"}</p>
            <p className="text-xs text-muted-foreground">
              {formatDuration(r.duration_ms)} · {(r.trigger_source || "manual")}
            </p>
            {r.error && (
              <p className="mt-1 text-xs text-[var(--warning,#F9735B)] truncate" title={r.error}>
                {humanizeRunError(r.error)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* P2-4: History shows a Completed pill for parity with failed runs. */}
            <RunStatusBadge status={r.status} showSuccess />
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
        </Link>
      ))}
    </div>
  );
}



// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------



// S29a: humanize raw enum option keys for display in select dropdowns.
// "branded_markdown" -> "Branded markdown"
// (humanizeRunError now lives in @/lib/run-format — P1-4 single source.)

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
  // P2: "ready" (never-run) is treated exactly like "healthy" — no pill.
  if (status === "healthy" || status === "ready" || !status) return null;
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
