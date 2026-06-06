"use client";

import { Fragment, useEffect, useRef, useState, useCallback } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Play, Plug, Pencil, ClipboardCheck, ChevronRight, ChevronDown,
  Copy, Code2, Clock, Plug2, ListChecks, History,
  Trash2, ArrowLeft, BookOpen, Save, X, Archive, ArchiveRestore, MoreVertical,
  Brain as BrainIcon, Settings2, Plus, RotateCcw, Search, Check,
} from "lucide-react";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { VersionDiffPanel } from "@/components/VersionDiffPanel";
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
import { ShareWorkerButton } from "@/components/ShareWorkerButton";
import { WorkerVisibilityControl } from "@/components/WorkerVisibilityControl";
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
  WorkerComposioConnection,
  WorkerContextSpec,
  WorkerMcpConnection,
  VersionSummary,
} from "@/lib/types";
import { CsvColumnMapper } from "@/components/csv-column-mapper";
import { FileInputUpload } from "@/components/FileInputUpload";
import { FilesEditor, TriggersEditor, WorkerMetadataForm, makeTriggerRow, buildTriggersYaml, replaceTriggerBlock } from "@/components/worker-form";
import type { TriggerRow } from "@/components/worker-form";
import type { WorkerMetadataValues } from "@/components/worker-form";
import {
  formatRelativeTime,
  formatScope,
  getSupportedApp,
  maskAccountLabel,
  normalizeAppSlug,
  SUPPORTED_APPS,
} from "@/components/connections/connection-data";
import { BrandLogo } from "@/components/connections/BrandLogo";
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
type Section = "about" | "run" | "settings" | "brain" | "code" | "connections" | "runs" | "versions";

const VALID_SECTIONS: Section[] = ["about", "run", "settings", "brain", "code", "connections", "runs", "versions"];

function isValidSection(s: string): s is Section {
  return VALID_SECTIONS.includes(s as Section);
}

// P2-3: the URL hash must match the visible tab label, not the internal
// Section id. Labels: About / Run / Runs / Source / Settings / Brain / Tools.
// Internal ids stay stable (runs/connections/code) for back-compat; only the
// hash slug the user sees/links changes.
// 2026-06-02: run-history hash is now `runs` (matches the "Runs" label set in
// PR #359). The legacy `#history` deep-link still resolves to the Runs tab via
// HASH_TO_SECTION below, so old links don't break.
const SECTION_TO_HASH: Record<Section, string> = {
  about: "about",
  run: "run",
  settings: "settings",
  brain: "brain",
  runs: "runs",
  // P2-3 / N2-1: canonical hash matches the visible "Tools" label. `#connections`
  // stays a back-compat alias in HASH_TO_SECTION below so old links don't break.
  connections: "tools",
  code: "source",
  versions: "versions",
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
  // N2-1: the tab is labelled "Tools"; `#tools` now resolves to it. The old
  // `#connections` slug stays mapped for back-compat with existing links.
  tools: "connections",
  connections: "connections",
  versions: "versions",
};

function hashToSection(h: string): Section | null {
  return HASH_TO_SECTION[h] ?? (isValidSection(h) ? h : null);
}

interface NavItem {
  id: Section;
  label: string;
  icon: React.ReactNode;
  // Tab grouping for visual rhythm: "view" = day-to-day/read tabs,
  // "setup" = configuration tabs. A subtle gap+divider separates the two
  // groups in the same row so the eye reads two short clusters instead of one
  // long run of 7 tabs.
  group: "view" | "setup";
}

// S34: Federico — "this page about this worker and run should be different
// tabs. These are completely different content and it's confusing." Restored
// About as a first-class tab (was inlined as <details> on the Run tab in S32).
// Grouped so the bar reads as two short clusters, not one long run of 7 tabs:
//   view group  → About · Run · Runs · Source   (what the worker is + does)
//   setup group → Settings · Brain · Connections (how it's configured)
// A subtle gap+divider sits between the groups in the same row. Every tab is
// still one click away — no nesting, no hidden features.
const NAV_ITEMS: NavItem[] = [
  { id: "about", label: "About", icon: <BookOpen className="w-4 h-4" />, group: "view" },
  { id: "run", label: "Run", icon: <Play className="w-4 h-4" />, group: "view" },
  { id: "runs", label: "Runs", icon: <ListChecks className="w-4 h-4" />, group: "view" },
  { id: "code", label: "Source", icon: <Code2 className="w-4 h-4" />, group: "view" },
  { id: "settings", label: "Settings", icon: <Settings2 className="w-4 h-4" />, group: "setup" },
  { id: "brain", label: "Brain", icon: <BrainIcon className="w-4 h-4" />, group: "setup" },
  // Labelled "Tools" (not "Connections") to disambiguate from the GLOBAL
  // Connections nav (account inventory). This per-worker tab shows the
  // tools/connections THIS worker is allowed to use — its permission
  // allowlist. Internal section id stays `connections` for hash/link
  // back-compat (see HASH_TO_SECTION).
  { id: "connections", label: "Tools", icon: <Plug2 className="w-4 h-4" />, group: "setup" },
];
// Note: "Versions" is intentionally NOT a tab. Worker config-version history is
// surfaced via a header "Versions" dropdown → dialog (VersionsSection), to match
// the inline Versions dropdown on Agent (/assistant) and Brain (/contexts) and
// to keep this bar from overflowing. `versions` stays a valid Section purely so
// the legacy `#versions` deep-link opens that dialog (see the effect above).

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

type EditableSourceFile = {
  path: string;
  content: string;
  binary?: boolean;
  language?: string;
  size?: number;
};

function toEditableSourceFiles(files: WorkerFile[]): EditableSourceFile[] {
  return files.map((f) => ({
    path: f.path,
    content: f.content || "",
    binary: f.binary,
    language: f.language,
    size: f.size,
  }));
}

function textSourceFiles(files: EditableSourceFile[]): { path: string; content: string }[] {
  return files
    .filter((f) => !f.binary)
    .map((f) => ({ path: f.path, content: f.content }));
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

function connectionSpecAllowedTools(spec: WorkerConnectionSpec): string[] | null {
  if (typeof spec === "string") return null;
  if ("composio" in spec && spec.composio?.allowed_tools?.length) {
    return spec.composio.allowed_tools;
  }
  if ("app" in spec && spec.allowed_tools?.length) {
    return spec.allowed_tools;
  }
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

// Mirror of patchBrainContexts for the connections block. Persists the worker's
// connection specs (Composio app slugs + allowed_tools, MCP specs) back into
// worker.yml via the same top-level-block replacement the Brain toggle uses.
function patchWorkerConnections(yaml: string, connections: WorkerConnectionSpec[]): string {
  const block = dumpYaml(
    { connections: connections.length > 0 ? connections : [] },
    { noRefs: true, lineWidth: -1, sortKeys: false },
  ).trimEnd();
  return replaceTopLevelYamlBlock(yaml, "connections", block);
}

// Produce a new connections list where the Composio entry for `slug` has its
// allowlist set to `tools`, or cleared when `tools` is null.
//
// Empty-allowlist semantics (backend models.py declared_composio_connections +
// main.py composio_execute gate, line ~9768): `allowed_tools is None` (the key
// absent) means FULL app access; an explicit list — INCLUDING an empty [] —
// RESTRICTS to exactly that set (an empty list blocks every tool). So clearing
// the restriction MUST drop the key entirely (tools === null), never emit [].
function setComposioAllowlist(
  connections: WorkerConnectionSpec[],
  slug: string,
  tools: string[] | null,
): WorkerConnectionSpec[] {
  const slugKey = slug.toLowerCase();
  let matched = false;
  const next = connections.map((spec): WorkerConnectionSpec => {
    const specApp = connectionSpecApp(spec);
    if (!specApp || specApp.toLowerCase() !== slugKey) return spec;
    matched = true;
    // Preserve any extra composio fields (scope/scopes) when present.
    const existingComposio =
      typeof spec === "object" && "composio" in spec ? spec.composio : undefined;
    const base: WorkerComposioConnection = {
      ...(existingComposio ?? {}),
      app: existingComposio?.app ?? specApp,
    };
    if (tools && tools.length > 0) {
      base.allowed_tools = tools;
    } else {
      delete base.allowed_tools;
    }
    return { composio: base };
  });
  // A bare-string declaration that we never matched as object means the slug
  // wasn't present at all; nothing to do.
  if (!matched) return connections;
  return next;
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
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<RunDetail | null>(null);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [brainPacks, setBrainPacks] = useState<ContextSummary[]>([]);
  const [savingBrain, setSavingBrain] = useState<string | null>(null);
  // Keyed by lowercased app slug while its tool allowlist is being persisted.
  const [savingAllowlist, setSavingAllowlist] = useState<string | null>(null);
  const [_selectedFile, setSelectedFile] = useState<string | null>(null);
  const activeRunStream = useRunStream(activeRunId);

  // Triggers edit state (always editable regardless of edit mode)
  const [triggerRows, setTriggerRows] = useState<TriggerRow[]>([]);
  const [triggersDirty, setTriggersDirty] = useState(false);

  // S42: edit mode — files editor state (Source tab in edit mode)
  const [editFiles, setEditFiles] = useState<EditableSourceFile[]>([]);
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

  // Config-version history. Unified to a "Versions" affordance across
  // Agent (/assistant), Brain (/contexts), and worker detail: instead of a
  // dedicated tab, worker config versions now open from a header "Versions"
  // dropdown trigger into a dialog that hosts the full list + diff + rollback
  // (VersionsSection), preserving every capability the old tab had.
  const [versionsOpen, setVersionsOpen] = useState(false);

  // Derived dirty flags
  const filesDirty = editFiles.some((f) => !f.binary && f.content !== (editFilesOriginal[f.path] ?? ""));
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

  // Versions is no longer a tab — it's a header dropdown that opens a dialog.
  // Preserve the legacy `#versions` deep-link: if a section ever resolves to
  // "versions" (initial hash, back/forward, pasted link), open the dialog and
  // snap the visible tab back to a real one so the tab bar stays valid.
  useEffect(() => {
    if (activeSection === "versions") {
      setVersionsOpen(true);
      setActiveSection("about");
    }
  }, [activeSection]);

  // S30: useState initializer only runs once. When the URL hash changes
  // externally (back/forward navigation, deep link, direct paste), the
  // activeSection state stayed at its initial value and the tabs got out
  // of sync with the URL. Listen to hashchange + popstate to re-sync.
  //
  // N2-2 (2026-06-03): clicking an in-app link to /workers/<id>#runs while
  // ALREADY on the worker page (e.g. from #about) didn't switch tabs. Next's
  // App Router performs hash-only same-route navigation via history.pushState,
  // which fires NEITHER `hashchange` NOR `popstate`, so the listeners below
  // never saw it. Patch pushState/replaceState to emit a synthetic event so
  // the live in-page switch works too. The patch is scoped to this effect and
  // fully restored on unmount.
  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.replace(/^#/, "");
      const next = hashToSection(h);
      if (next && next !== activeSection) setActiveSection(next);
    };
    const EVT = "workeros:locationchange";
    const origPush = window.history.pushState;
    const origReplace = window.history.replaceState;
    const emit = () => window.dispatchEvent(new Event(EVT));
    window.history.pushState = function (...args) {
      const r = origPush.apply(this, args as Parameters<typeof origPush>);
      emit();
      return r;
    };
    window.history.replaceState = function (...args) {
      const r = origReplace.apply(this, args as Parameters<typeof origReplace>);
      emit();
      return r;
    };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    window.addEventListener(EVT, sync);
    return () => {
      window.history.pushState = origPush;
      window.history.replaceState = origReplace;
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
      window.removeEventListener(EVT, sync);
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
      setFetchError(null);
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
        const editableFiles = toEditableSourceFiles(files);
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
        } else {
          // C1: store the error message so the error state can surface it.
          // Sanitise: strip raw stack traces, keep the first sentence only.
          const safe = msg.split(/\n/)[0]?.trim() || "Network or server error";
          setFetchError(safe);
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

  // Clone-on-edit: a PUT /workers/{id}/files against a read-only stock worker
  // forks it into a user-owned copy. The response carries `cloned_from` + a new
  // `id`. When that happens, redirect to the copy (the URL the operator was on
  // points at the immutable stock worker) and stop the in-place refetch the
  // caller would otherwise run. Returns true if a redirect was issued.
  function maybeRedirectToClone(saved: WorkerDetail, hash?: string): boolean {
    if (saved.cloned_from && worker && saved.id !== worker.id) {
      toast.success("Editing created your copy of this worker");
      router.replace(`/workers/${saved.id}${hash ? `#${hash}` : ""}`);
      return true;
    }
    return false;
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
      const patchedFiles = textSourceFiles(editFiles);

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

      const saved = await api.workers.updateFiles(worker.id, patchedFiles);
      if (maybeRedirectToClone(saved, "code")) return;
      toast.success("Worker saved");
      // Reload worker and reset dirty state
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      const updatedFiles = toEditableSourceFiles(deriveSourceFiles(updated));
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
      const saved = await api.workers.updateFiles(worker.id, textSourceFiles(editFiles));
      if (maybeRedirectToClone(saved, "code")) return;
      toast.success("Worker saved");
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      // Sync editFiles
      const updatedFiles = toEditableSourceFiles(deriveSourceFiles(updated));
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
      // Sync retry state
      const retryCfg = (updated.config as { retry?: { max_attempts?: number; delay_seconds?: number } }).retry;
      setRetryEnabled(!!retryCfg);
      setRetryMaxAttempts(retryCfg?.max_attempts ?? 3);
      setRetryDelaySeconds(retryCfg?.delay_seconds ?? 60);
      // Sync notify state
      const notifyCfg = (updated.config as { notify?: { url?: string; email_to?: string[]; on?: string[] } }).notify;
      setNotifyUrl(notifyCfg?.url ?? "");
      setNotifyEmailTo((notifyCfg?.email_to ?? []).join(", "));
      setNotifyOnFailed(notifyCfg ? (notifyCfg.on ?? ["failed"]).includes("failed") : true);
      setNotifyOnCompleted(notifyCfg ? (notifyCfg.on ?? []).includes("completed") : false);
      // Sync form state (Source tab Form view)
      setFormName(updated.name || "");
      setFormInputs(updated.config.inputs || []);
      setFormOutputs(updated.config.outputs || []);
      setFormSecrets(updated.config.secrets || []);
      setFormConnections(
        (updated.config.connections || []).filter((c: unknown) => typeof c === "string") as string[]
      );
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
      const saved = await api.workers.updateFiles(worker.id, [{ path: "worker.yml", content: patched }]);
      if (maybeRedirectToClone(saved)) return;
      toast.success("Defaults saved — scheduled runs will now use these values");
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      setSetupDefaults({});
      const updatedFiles = toEditableSourceFiles(deriveSourceFiles(updated));
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
          ? textSourceFiles(editFiles)
          : deriveSourceFiles(worker)
              .filter((f) => !f.binary)
              .map((f) => ({ path: f.path, content: f.content || "" }));
      const nextFiles = sourceFiles.some((f) => f.path === "worker.yml")
        ? sourceFiles.map((f) => (f.path === "worker.yml" ? { ...f, content: patched } : f))
        : [{ path: "worker.yml", content: patched }, ...sourceFiles];

      const saved = await api.workers.updateFiles(worker.id, nextFiles);
      if (maybeRedirectToClone(saved, "brain")) return;
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      const updatedFiles = toEditableSourceFiles(deriveSourceFiles(updated));
      setEditFiles(updatedFiles);
      const newSnap: Record<string, string> = {};
      for (const f of updatedFiles) newSnap[f.path] = f.content;
      setEditFilesOriginal(newSnap);
      toast.success(selected ? "Brain resource removed" : "Brain resource attached");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update brain resources");
    } finally {
      setSavingBrain(null);
    }
  }

  // Persist a Composio app's tool allowlist into worker.yml, reusing the exact
  // save path the Brain toggle uses (yaml-block patch -> updateFiles -> refetch).
  // `tools === null` clears the restriction (drops allowed_tools => full access).
  async function handleSetComposioAllowlist(slug: string, tools: string[] | null) {
    if (!worker || savingAllowlist) return;
    const slugKey = slug.toLowerCase();
    const currentConnections = worker.config.connections ?? [];
    const nextConnections = setComposioAllowlist(currentConnections, slug, tools);

    const currentYml =
      editFiles.find((f) => f.path === "worker.yml")?.content ||
      deriveSourceFiles(worker).find((f) => f.path === "worker.yml")?.content ||
      worker.manifest_yaml ||
      "";

    if (!currentYml.trim()) {
      toast.error("worker.yml is unavailable for this worker");
      return;
    }

    setSavingAllowlist(slugKey);
    try {
      const patched = patchWorkerConnections(currentYml, nextConnections);
      const sourceFiles =
        editFiles.length > 0
          ? textSourceFiles(editFiles)
          : deriveSourceFiles(worker)
              .filter((f) => !f.binary)
              .map((f) => ({ path: f.path, content: f.content || "" }));
      const nextFiles = sourceFiles.some((f) => f.path === "worker.yml")
        ? sourceFiles.map((f) => (f.path === "worker.yml" ? { ...f, content: patched } : f))
        : [{ path: "worker.yml", content: patched }, ...sourceFiles];

      const saved = await api.workers.updateFiles(worker.id, nextFiles);
      if (maybeRedirectToClone(saved, "connections")) return;
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      const updatedFiles = toEditableSourceFiles(deriveSourceFiles(updated));
      setEditFiles(updatedFiles);
      const newSnap: Record<string, string> = {};
      for (const f of updatedFiles) newSnap[f.path] = f.content;
      setEditFilesOriginal(newSnap);
      toast.success("Tool allowlist updated");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update tool allowlist");
    } finally {
      setSavingAllowlist(null);
    }
  }

  // X6: ADD a brand-new tool/connection even when the worker declares none
  // (connections: []). Appends the slug as a connections entry and persists via
  // the same yaml-block patch -> updateFiles -> refetch path the allowlist editor
  // uses. No-op (with a toast) if the slug is already declared.
  async function handleAddConnection(rawSlug: string) {
    if (!worker || savingAllowlist) return;
    const slug = rawSlug.trim().toLowerCase();
    if (!slug) return;
    const currentConnections = worker.config.connections ?? [];
    const alreadyDeclared = currentConnections.some(
      (spec) => (connectionSpecApp(spec) || "").toLowerCase() === slug,
    );
    if (alreadyDeclared) {
      toast.info("That tool is already added to this worker");
      return;
    }
    // Append as a bare-string slug (full app access). The operator can then
    // restrict tools via the per-app allowlist editor that now renders for it.
    const nextConnections: WorkerConnectionSpec[] = [...currentConnections, slug];

    const currentYml =
      editFiles.find((f) => f.path === "worker.yml")?.content ||
      deriveSourceFiles(worker).find((f) => f.path === "worker.yml")?.content ||
      worker.manifest_yaml ||
      "";

    if (!currentYml.trim()) {
      toast.error("worker.yml is unavailable for this worker");
      return;
    }

    setSavingAllowlist(slug);
    try {
      const patched = patchWorkerConnections(currentYml, nextConnections);
      const sourceFiles =
        editFiles.length > 0
          ? textSourceFiles(editFiles)
          : deriveSourceFiles(worker)
              .filter((f) => !f.binary)
              .map((f) => ({ path: f.path, content: f.content || "" }));
      const nextFiles = sourceFiles.some((f) => f.path === "worker.yml")
        ? sourceFiles.map((f) => (f.path === "worker.yml" ? { ...f, content: patched } : f))
        : [{ path: "worker.yml", content: patched }, ...sourceFiles];

      const saved = await api.workers.updateFiles(worker.id, nextFiles);
      if (maybeRedirectToClone(saved, "connections")) return;
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      const updatedFiles = toEditableSourceFiles(deriveSourceFiles(updated));
      setEditFiles(updatedFiles);
      const newSnap: Record<string, string> = {};
      for (const f of updatedFiles) newSnap[f.path] = f.content;
      setEditFilesOriginal(newSnap);
      toast.success("Tool added");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to add tool");
    } finally {
      setSavingAllowlist(null);
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

      const saved = await api.workers.updateFiles(worker.id, [{ path: "worker.yml", content: patched }]);
      if (maybeRedirectToClone(saved, "settings")) return;
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
      const updatedFiles = toEditableSourceFiles(deriveSourceFiles(updated));
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

      const saved = await api.workers.updateFiles(worker.id, [{ path: "worker.yml", content: patched }]);
      if (maybeRedirectToClone(saved, "settings")) return;
      toast.success("Settings saved");
      setTriggersDirty(false);
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
      const updatedFiles = toEditableSourceFiles(deriveSourceFiles(updated));
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

      if (formName.trim()) parsed.title = formName.trim();
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
      const saved = await api.workers.updateFiles(worker.id, [{ path: "worker.yml", content: newYaml }]);
      if (maybeRedirectToClone(saved, "settings")) return;
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
      const updatedFiles = toEditableSourceFiles(deriveSourceFiles(updated));
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
        <p className="text-xs text-muted-foreground">
          {fetchError ?? "Something went wrong fetching this worker."}
        </p>
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
      {/* Mobile (375): stack — title/description/icon-strip column gets the FULL
          width, and the shrink-0 action cluster (Versions/Share/Edit/actions)
          drops BELOW it instead of competing for width and starving the
          flex-1 min-w-0 column to ~0px (one-word-per-line bug). From sm: up the
          original `flex items-start gap-4` row layout is restored unchanged. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
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
            {/* N7: when a secret is missing, surface a quick-fix CTA so the user
                doesn't have to hunt for where to add the secret. */}
            {worker.status === "missing_secret" && (
              <Link
                href="/secrets"
                className="inline-flex items-center gap-1 rounded-[var(--radius-button)] px-2 py-0.5 text-[11px] font-medium text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
              >
                Add secret →
              </Link>
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
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setVersionsOpen(true)}
              aria-label="Versions"
            >
              <History className="size-3.5" />
              Versions
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
            <Button
              variant="outline"
              size="sm"
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
          </div>
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
            {/* Unified "Versions" affordance (matches the inline Versions
                dropdown on Agent /assistant + Brain /contexts). Was a dedicated
                tab; now a quiet header trigger that opens the full version
                list + diff + rollback in a dialog (VersionsSection). */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setVersionsOpen(true)}
              aria-label="Versions"
              /* P2 touch-target: >=44px tall on mobile (coarse pointers),
                 compact on desktop. */
              className="min-h-11 sm:min-h-0"
            >
              <History className="size-3.5" />
              Versions
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
            {/* Visibility (Share) control: Private <-> Shared with workspace.
                Private default; renders on the OSS single-owner engine too. */}
            <span className="[&_button]:min-h-11 sm:[&_button]:min-h-0">
              <WorkerVisibilityControl
                worker={worker}
                onChange={(updated) => setWorker(updated)}
              />
            </span>
            <span className="[&_button]:min-h-11 sm:[&_button]:min-h-0">
              <ShareWorkerButton workerId={worker.id} workerName={worker.name} />
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={enterEditMode}
              className="min-h-11 sm:min-h-0"
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
                  className="inline-flex h-11 w-11 sm:h-8 sm:w-8 items-center justify-center rounded-[var(--radius-button)] border border-input bg-background text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
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

      {/* Versions dialog. Hosts the full config-version history (list +
          per-version diff + rollback) that used to be a dedicated tab. Opened
          from the header "Versions" trigger so the affordance matches Assistant
          (/assistant) and Brain (/contexts) and the tab bar stays compact. */}
      <Dialog open={versionsOpen} onOpenChange={setVersionsOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Versions</DialogTitle>
            <DialogDescription>
              A snapshot is saved on every edit. Click a version to preview the
              diff and restore it.
            </DialogDescription>
          </DialogHeader>
          <VersionsSection worker={worker} onRollback={(updated) => setWorker(updated)} />
        </DialogContent>
      </Dialog>

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
            <Button size="sm" onClick={() => { if (pendingSaveAfterConflict) commitFormSave(); }}>
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
          container so nothing scrolls and it looks identical.
          M1 (2026-06-02): the scroll <div> now sits INSIDE <Tabs> and wraps
          <TabsList> directly, matching the proven /settings pattern. Previously
          the scroll <div> was OUTSIDE <Tabs>, so its direct child was the
          flex-column <Tabs> root (not the `w-fit` list) — the overflow chain
          didn't reliably reach the list and the last tab (History) clipped with
          no scroll. Wrapping the `w-fit` list directly restores the swipe. */}
      <Tabs value={activeSection} onValueChange={(v) => setSection(v as Section)}>
        <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:px-0">
          {/* E2: the shared TabsList is h-8 (32px) — below the 44px touch
              minimum. Bump the bar (and via h-full each trigger) to ≥44px on
              mobile only; desktop keeps the tight 32px height. */}
          <TabsList className="h-11 min-h-11 sm:h-8 sm:min-h-0">
            {NAV_ITEMS.map((item, i) => {
              // Divider at the view→setup group boundary: extra gap + a hairline
              // rule so the 7 tabs read as two short clusters in one row. Every
              // tab stays one click away; this is purely visual rhythm.
              const startsNewGroup = i > 0 && NAV_ITEMS[i - 1].group !== item.group;
              return (
                <Fragment key={item.id}>
                  {startsNewGroup && (
                    <span
                      aria-hidden
                      className="mx-1 h-4 w-px shrink-0 self-center bg-border"
                    />
                  )}
                  <TabsTrigger value={item.id}>
                    {item.icon}
                    <span>{item.label}</span>
                    {item.id === "settings" && triggersCount > 1 && (
                      <span className="ml-1 text-[10px] bg-muted-foreground/20 text-muted-foreground rounded px-1">{triggersCount}</span>
                    )}
                    {item.id === "runs" && runsCount > 0 && (
                      <span className="ml-1 text-[10px] bg-muted-foreground/20 text-muted-foreground rounded px-1">{runsCount}</span>
                    )}
                  </TabsTrigger>
                </Fragment>
              );
            })}
          </TabsList>
        </div>
      </Tabs>

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
                <p className="text-xs text-muted-foreground mt-0.5">Get notified when runs complete or fail.</p>
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Webhook URL</Label>
                <Input
                  type="url"
                  className="text-sm"
                  placeholder="e.g. https://hooks.example.com/run-events"
                  value={notifyUrl}
                  onChange={(e) => setNotifyUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Email recipients</Label>
                <Input
                  type="text"
                  className="text-sm"
                  placeholder="alice@example.com, bob@example.com"
                  value={notifyEmailTo}
                  onChange={(e) => setNotifyEmailTo(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Comma-separated. Sent via Resend.</p>
              </div>
              {(notifyUrl.trim() || notifyEmailTo.trim()) && (
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
            <FilesEditor
              mode="edit"
              files={editFiles}
              selectedPath={editSelectedPath}
              onSelect={setEditSelectedPath}
              onSelectedPathChange={setEditSelectedPath}
              onChange={setEditFiles}
              renderYamlPreview={(
                <div className="max-w-2xl space-y-6">
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
                      <p className="text-xs text-muted-foreground mt-0.5">Default values run on schedule or without manual input.</p>
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
                      <Plus className="size-3" /> Add
                    </button>
                  </div>
                  {formInputs.length > 0 && (
                    <div className="rounded-lg border border-border divide-y divide-border">
                      {formInputs.map((inp, idx) => (
                        <div key={inp.name + idx} className="flex items-center gap-2 px-3 py-2">
                          <span className="text-xs font-mono text-foreground shrink-0 w-44 truncate" title={inp.name}>{inp.name}</span>
                          <Input
                            className="h-7 text-xs flex-1"
                            placeholder="default value…"
                            value={inp.default !== undefined && inp.default !== null ? String(inp.default) : ""}
                            onChange={(e) =>
                              setFormInputs((prev) =>
                                prev.map((p, i) => i === idx ? { ...p, default: e.target.value } : p)
                              )
                            }
                          />
                          <button
                            type="button"
                            title="Toggle required"
                            onClick={() =>
                              setFormInputs((prev) =>
                                prev.map((p, i) => i === idx ? { ...p, required: !p.required } : p)
                              )
                            }
                            className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${inp.required ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground"}`}
                          >
                            req
                          </button>
                          <button
                            type="button"
                            onClick={() => setFormInputs((prev) => prev.filter((_, i) => i !== idx))}
                            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {formInputs.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">No inputs defined.</p>
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
                          <Plus className="size-3" /> Add
                        </button>
                      </div>
                      {formOutputs.length > 0 ? (
                        <div className="rounded-lg border border-border divide-y divide-border">
                          {formOutputs.map((out, idx) => (
                            <div key={out.name + idx} className="flex items-center gap-2 px-3 py-2">
                              <span className="text-xs font-mono text-foreground shrink-0 w-44 truncate" title={out.name}>{out.name}</span>
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
                              <button
                                type="button"
                                onClick={() => setFormOutputs((prev) => prev.filter((_, i) => i !== idx))}
                                className="text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-auto"
                              >
                                <X className="size-3" />
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
            />
            {/* YAML code save — only visible when code has been edited */}
            {/* N25: only show Save+Discard when the YAML has been edited —
                never show Save in a pristine (no-edits-pending) state. */}
            {filesDirty && (
              <div className="flex items-center gap-3 pt-1">
                <Button size="sm" onClick={handleSaveAdvanced} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setEditFiles(
                      editFiles.map((file) =>
                        file.binary
                          ? file
                          : { ...file, content: editFilesOriginal[file.path] ?? file.content }
                      )
                    )
                  }
                  disabled={saving}
                >
                  Discard
                </Button>
                <span className="text-xs text-muted-foreground">Unsaved changes</span>
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
            savingAllowlist={savingAllowlist}
            onSetComposioAllowlist={handleSetComposioAllowlist}
            onAddConnection={handleAddConnection}
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
        {/* Versions is no longer a tab — it opens from the header "Versions"
            dropdown into a dialog (see <Dialog open={versionsOpen}> above). */}
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
  // N18: surface the needs-attention reason directly on the About tab instead
  // of burying it. The Run tab shows "Connect X" inline; the About tab shows
  // "Missing secret: <NAME>" with a quick link to /secrets.
  const requiredSecrets: string[] = worker.config.secrets ?? [];
  const isMissingSecret = worker.status === "missing_secret";
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
  // N18: attention banner shared between both return paths.
  const attentionBanner = isMissingSecret && requiredSecrets.length > 0 ? (
    <div className="max-w-2xl rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 px-4 py-3 flex items-start gap-3">
      <span className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400">⚠</span>
      <div className="space-y-1 min-w-0">
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">Missing secret</p>
        <p className="text-xs text-amber-700 dark:text-amber-400">
          This worker requires{" "}
          <span className="font-mono font-semibold">{requiredSecrets.join(", ")}</span>{" "}
          to run.{" "}
          <Link href="/secrets" className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200">
            Add it in Secrets →
          </Link>
        </p>
      </div>
    </div>
  ) : null;

  if (!hasContent) {
    // The Flow diagram is a fixed-width monospace grid that can be wider than
    // the prose column; it spans the full content width (with its own internal
    // overflow-x fallback) so the OUTPUTS column is never clipped on desktop.
    // Prose stays at max-w-2xl for readability.
    return (
      <div className="space-y-6">
        {attentionBanner}
        {diagram}
        <p className="max-w-2xl text-sm text-muted-foreground">
          {worker.description || "No description provided."}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {attentionBanner}
      {diagram}
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
            {worker.how_it_works.replace(/(^|\s)->(\s)/g, "$1→$2")}
          </p>
        </div>
      )}
      </div>
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
    .filter((spec) => {
      const name = contextSpecName(spec);
      return name && !knownPackNames.has(name);
    });

  const sortedPacks = [...brainPacks].sort((a, b) => {
    const aSelected = selectedNames.has(a.name) ? 0 : 1;
    const bSelected = selectedNames.has(b.name) ? 0 : 1;
    if (aSelected !== bSelected) return aSelected - bSelected;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Brain resources</h2>
          <p className="text-sm text-muted-foreground">
            {selectedNames.size === 0
              ? "No brain resources attached — toggle any pack below to attach it."
              : `${selectedNames.size} brain ${selectedNames.size === 1 ? "pack" : "packs"} attached. Toggle to add or remove.`}
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
            Unavailable resources declared in worker.yml: {missingSelectedPacks.map(contextSpecName).join(", ")}
          </p>
        </div>
      )}

      {sortedPacks.length === 0 && missingSelectedPacks.length === 0 ? (
        <div className="rounded-[var(--radius-button)] border border-line bg-card p-4">
          <p className="text-sm text-muted-foreground">No brain resources available.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {missingSelectedPacks.length > 0 && (
            <div className="overflow-hidden rounded-[var(--radius-button)] border border-line bg-card">
              {missingSelectedPacks.map((spec, index) => {
                const name = contextSpecName(spec);
                const writableMount = contextSpecWritable(spec);
                return (
                  <div
                    key={`${name}-${index}`}
                    className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 last:border-b-0"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] border border-line bg-[var(--paper)]">
                        <BrainIcon className="size-4 text-muted-foreground" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">{name}</span>
                          <Badge variant="outline" className="border-line text-xs text-muted-foreground">
                            Declared in YAML
                          </Badge>
                          <Badge variant="outline" className="border-amber-300 bg-amber-50 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
                            Unavailable
                          </Badge>
                          <Badge variant="outline" className="border-line text-xs text-muted-foreground">
                            {writableMount ? "Read/write" : "Read-only"}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Declared in worker.yml; not returned by the Brain API.
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {sortedPacks.length > 0 && (
            <div className="overflow-hidden rounded-[var(--radius-button)] border border-line bg-card">
              {sortedPacks.map((pack) => {
                const attached = selectedNames.has(pack.name);
                const selectedSpec = selectedSpecs.find((spec) => contextSpecName(spec) === pack.name);
                const writableMount = selectedSpec ? contextSpecWritable(selectedSpec) : false;
                const packWritable = pack.writeable && !pack.system && !pack.read_only;
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
                          <Badge variant="outline" className="border-line text-xs text-muted-foreground">
                            Ready
                          </Badge>
                          <Badge variant="outline" className="border-line text-xs text-muted-foreground">
                            {attached ? (writableMount ? "Read/write" : "Read-only") : packWritable ? "Can write" : "Read-only"}
                          </Badge>
                        </div>
                        {pack.description && (
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{pack.description}</p>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {pack.file_count === 0
                            ? <span className="italic">Empty pack (no files yet)</span>
                            : <>{pack.file_count} {pack.file_count === 1 ? "file" : "files"}</>}
                          {pack.worker_count !== undefined && pack.worker_count > 0 ? ` · used by ${pack.worker_count} ${pack.worker_count === 1 ? "worker" : "workers"}` : ""}
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
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections section
// ---------------------------------------------------------------------------

// Point-and-click editor for a single Composio app's worker-level tool
// allowlist. Persists via the parent's onSet (yaml-block patch -> updateFiles).
//
// Empty-allowlist semantics preserved (backend gate main.py ~9768): no
// allowed_tools => FULL app access; an explicit list => restricted. The
// "Restrict tools" switch off => onSet(slug, null) drops the key (full access);
// on => the worker is limited to the listed slugs.
//
// NOTE (Codex flag): there is no per-app tool-CATALOG endpoint exposed to the
// client. /integrations/catalog only returns `tools_count`, and the backend has
// no route that lists a toolkit's tool slugs (Composio v3 `/tools?toolkit_slug=`
// is unwired). So we cannot render checkboxes against the full toolkit; we let
// the user manage the existing entries + add by slug. Wiring a
// GET /integrations/tools?app=<slug> proxy (Composio v3 /tools) would unlock a
// real per-tool checklist here.
function ComposioAllowlistEditor({
  slug,
  allowedTools,
  saving,
  disabled,
  onSet,
}: {
  slug: string;
  allowedTools: string[] | null;
  saving: boolean;
  disabled: boolean;
  onSet: (slug: string, tools: string[] | null) => void | Promise<void>;
}) {
  const restricted = (allowedTools?.length ?? 0) > 0;
  const [addValue, setAddValue] = useState("");
  // Local intent so the user can switch "Restrict" on and see the add UI before
  // any slug exists (we never persist an empty [] — see semantics note above).
  const [localRestrictIntent, setLocalRestrictIntent] = useState(false);
  const busy = saving || disabled;
  const showRestricted = restricted || localRestrictIntent;

  function handleToggleRestrict(next: boolean) {
    if (busy) return;
    if (next) {
      // Reveal the add UI. We do NOT persist an empty [] (it would block all
      // tools); persistence happens only once the first slug is added.
      setAddValue("");
      setLocalRestrictIntent(true);
    } else {
      setLocalRestrictIntent(false);
      void onSet(slug, null);
    }
  }

  function handleAdd() {
    const slugToAdd = addValue.trim().toUpperCase();
    if (!slugToAdd || busy) return;
    const current = allowedTools ?? [];
    if (current.some((t) => t.toUpperCase() === slugToAdd)) {
      setAddValue("");
      return;
    }
    setAddValue("");
    void onSet(slug, [...current, slugToAdd]);
  }

  function handleRemove(tool: string) {
    if (busy) return;
    const current = allowedTools ?? [];
    const next = current.filter((t) => t !== tool);
    // Removing the last slug clears the restriction entirely (full access)
    // rather than persisting an empty list that would block every tool.
    if (next.length === 0) {
      setLocalRestrictIntent(true); // keep the add UI visible after clearing
      void onSet(slug, null);
    } else {
      void onSet(slug, next);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">Restrict tools</p>
          <p className="text-[0.68rem] text-muted-foreground">
            {showRestricted
              ? "Worker can only use the tools listed below."
              : "Worker can use every tool this app exposes."}
          </p>
        </div>
        <Switch
          checked={showRestricted}
          disabled={busy}
          onCheckedChange={handleToggleRestrict}
          aria-label={`Restrict ${slug} tools`}
        />
      </div>

      {showRestricted && (
        <div className="space-y-2">
          {allowedTools && allowedTools.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {allowedTools.map((tool) => (
                <Badge
                  key={tool}
                  variant="outline"
                  className="max-w-full items-center gap-1 border-line bg-muted px-2 font-mono text-[0.68rem]"
                >
                  <span className="max-w-[200px] truncate">{tool}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${tool}`}
                    disabled={busy}
                    onClick={() => handleRemove(tool)}
                    className="ml-0.5 rounded-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-[0.68rem] text-muted-foreground">
              No tools allowed yet — add at least one slug below, or turn off
              Restrict tools for full access.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Input
              value={addValue}
              disabled={busy}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              placeholder="Tool slug e.g. GMAIL_FETCH_EMAILS"
              className="h-8 flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 border-line"
              disabled={busy || !addValue.trim()}
              onClick={handleAdd}
            >
              {saving ? "Saving…" : "Add"}
            </Button>
          </div>
          <p className="text-[0.6rem] text-muted-foreground">
            Tool slugs come from the app&apos;s Composio toolkit (uppercase, e.g.{" "}
            <span className="font-mono">SLACK_SEND_MESSAGE</span>). A live per-app
            tool picker is not available yet.
          </p>
        </div>
      )}
    </div>
  );
}

// X6: add a NEW tool/connection to a worker — works whether the worker already
// declares connections or declares none (connections: []). Offers the supported
// apps that are not already declared, plus a free-text slug fallback for apps not
// in the curated list. The chosen slug is appended to worker.yml `connections`
// via the parent's onAdd (yaml-block patch -> updateFiles -> refetch).
function AddToolControl({
  existingSlugs,
  saving,
  onAdd,
}: {
  existingSlugs: string[];
  saving: string | null;
  onAdd: (slug: string) => void | Promise<void>;
}) {
  const [selected, setSelected] = useState("");
  const [customSlug, setCustomSlug] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const existing = new Set(existingSlugs.map((s) => s.toLowerCase()));
  const options = SUPPORTED_APPS.filter((app) => !existing.has(app.slug.toLowerCase()));
  const filteredOptions = options.filter((app) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return app.displayName.toLowerCase().includes(q) || app.slug.toLowerCase().includes(q);
  });
  const busy = saving !== null;
  const selectedApp = selected && selected !== "__custom__" ? getSupportedApp(selected) : null;

  const slugToAdd =
    selected === "__custom__" ? normalizeAppSlug(customSlug) : selected;
  const canAdd = !busy && !!slugToAdd && !existing.has(slugToAdd.toLowerCase());

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
        <DropdownMenuTrigger
          className="inline-flex h-8 w-56 items-center justify-between rounded-[var(--radius-button)] border border-line bg-card px-2 text-xs font-normal text-foreground shadow-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
          disabled={busy}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selectedApp ? (
              <span className="flex size-5 shrink-0 items-center justify-center rounded border border-line bg-card">
                <BrandLogo icon={selectedApp.icon} className="size-3.5" />
              </span>
            ) : selected === "__custom__" ? (
              <span className="flex size-5 shrink-0 items-center justify-center rounded border border-line bg-muted text-[0.65rem] font-medium text-muted-foreground">
                #
              </span>
            ) : null}
            <span className="truncate">
              {selectedApp?.displayName || (selected === "__custom__" ? "Other (enter slug)" : "Add a tool...")}
            </span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 p-2">
          <div className="relative mb-2">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Search apps..."
              className="h-8 pl-7 text-xs"
              autoFocus
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {filteredOptions.map((app) => (
              <DropdownMenuItem
                key={app.slug}
                className="flex cursor-pointer items-center gap-2 text-xs"
                onSelect={() => {
                  setSelected(app.slug);
                  setPickerOpen(false);
                  setQuery("");
                }}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded border border-line bg-card">
                  <BrandLogo icon={app.icon} className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate">{app.displayName}</span>
                {selected === app.slug ? <Check className="size-3.5 text-muted-foreground" /> : null}
              </DropdownMenuItem>
            ))}
            {filteredOptions.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">No matching apps.</div>
            ) : null}
            <DropdownMenuItem
              className="mt-1 flex cursor-pointer items-center gap-2 border-t border-line pt-2 text-xs"
              onSelect={() => {
                setSelected("__custom__");
                setPickerOpen(false);
                setQuery("");
              }}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded border border-line bg-muted text-[0.65rem] font-medium text-muted-foreground">
                #
              </span>
              <span className="min-w-0 flex-1 truncate">Other (enter slug)</span>
              {selected === "__custom__" ? <Check className="size-3.5 text-muted-foreground" /> : null}
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {selected === "__custom__" && (
        <Input
          value={customSlug}
          disabled={busy}
          onChange={(e) => setCustomSlug(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canAdd) {
              e.preventDefault();
              void onAdd(slugToAdd);
            }
          }}
          placeholder="App slug e.g. airtable"
          className="h-8 w-40 font-mono text-xs"
        />
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 border-line"
        disabled={!canAdd}
        onClick={() => {
          void Promise.resolve(onAdd(slugToAdd)).then(() => {
            setSelected("");
            setCustomSlug("");
          });
        }}
      >
        {busy ? "Saving…" : "Add tool"}
      </Button>
    </div>
  );
}

function ConnectionsSection({
  worker,
  connections,
  requiredConnections,
  configuredMcpConnections,
  activeConnectionSlugs,
  requiredSecrets,
  savingAllowlist,
  onSetComposioAllowlist,
  onAddConnection,
}: {
  worker: WorkerDetail;
  connections: ConnectionItem[];
  requiredConnections: string[];
  configuredMcpConnections: WorkerMcpConnection[];
  activeConnectionSlugs: Set<string>;
  requiredSecrets: string[];
  savingAllowlist: string | null;
  onSetComposioAllowlist: (slug: string, tools: string[] | null) => void | Promise<void>;
  onAddConnection: (slug: string) => void | Promise<void>;
}) {
  const composioRequirements = (worker.config.connections ?? [])
    .map((spec) => {
      const slug = connectionSpecApp(spec);
      if (!slug) return null;
      return {
        slug,
        allowedTools: connectionSpecAllowedTools(spec),
      };
    })
    .filter((item): item is { slug: string; allowedTools: string[] | null } => Boolean(item));
  const uniqueComposioRequirements = Array.from(
    new Map(composioRequirements.map((item) => [item.slug.toLowerCase(), item])).values()
  );

  // S29m (ChatGPT-audit P-3): drop Card wrappers; render as flat sections
  // matching Overview tab rhythm.
  return (
    <div className="max-w-3xl space-y-8">
      {requiredConnections.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">Tools this worker can use</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                The connections and tools this worker is allowed to use. These are this worker&apos;s
                permissions — separate from your account-wide Connections inventory. Worker-level
                allowlists limit tool execution even when an account grants broader OAuth scopes.
              </p>
            </div>
            <Link href="/connections">
              <Button size="sm" variant="outline" className="h-8 border-line">
                Manage
              </Button>
            </Link>
          </div>
          <div className="overflow-hidden rounded-lg border border-line bg-card">
            {uniqueComposioRequirements.map(({ slug, allowedTools }) => {
              const slugKey = slug.toLowerCase();
              const app = getSupportedApp(slug);
              const appConnections = connections.filter(
                (connection) =>
                  connection.kind !== "mcp" &&
                  connection.app_name.toLowerCase() === slugKey,
              );
              const activeConnections = appConnections.filter(
                (connection) => connection.status === "active",
              );
              const activeConnection = activeConnections[0];
              const isActive = activeConnectionSlugs.has(slugKey);
              const displayName = activeConnection?.display_name?.trim();
              const accountLabel = activeConnection?.account_label?.trim();
              const connectionLabel =
                accountLabel ||
                (displayName && displayName.toLowerCase() !== app.displayName.toLowerCase()
                  ? displayName
                  : "");
              const latestStatus = appConnections[0]?.status;
              const grantedScopes = activeConnection?.scopes ?? [];
              return (
                <div key={slug} className="grid gap-4 border-b border-line p-4 last:border-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{app.displayName}</span>
                      {isActive ? (
                        <Badge variant="outline" className="border-line text-xs text-muted-foreground">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-amber-200 bg-amber-50 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
                          Missing
                        </Badge>
                      )}
                      {allowedTools?.length ? (
                        <Badge variant="outline" className="border-line bg-muted text-xs">
                          {allowedTools.length} allowed tools
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-line bg-muted text-xs">
                          Full app tool access
                        </Badge>
                      )}
                    </div>
                    {connectionLabel ? (
                      <p className="truncate text-xs text-muted-foreground">{maskAccountLabel(connectionLabel)}</p>
                    ) : latestStatus ? (
                      <p className="truncate text-xs text-muted-foreground">Status: {latestStatus}</p>
                    ) : null}
                    {!isActive && (
                      <Link href="/connections">
                        <Button size="sm" variant="outline" className="h-7 border-line text-xs">
                          Connect
                        </Button>
                      </Link>
                    )}
                  </div>

                  <div className="min-w-0 space-y-3">
                    <ComposioAllowlistEditor
                      slug={slug}
                      allowedTools={allowedTools}
                      saving={savingAllowlist === slugKey}
                      disabled={savingAllowlist !== null && savingAllowlist !== slugKey}
                      onSet={onSetComposioAllowlist}
                    />

                    {/* N6-2: OAuth scopes can include sensitive personal-data
                        grants (contacts, birthday, phone numbers). Show a count
                        summary by default and collapse the raw scope slugs
                        behind a disclosure so they aren't dumped in plain view. */}
                    {grantedScopes.length > 0 ? (
                      <details className="group overflow-hidden rounded-[var(--radius-button)] border border-line bg-paper">
                        <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-foreground">
                          <span>
                            {grantedScopes.length} OAuth{" "}
                            {grantedScopes.length === 1 ? "scope" : "scopes"} granted
                          </span>
                          <span className="text-[0.68rem] font-normal text-muted-foreground group-open:hidden">
                            View scopes
                          </span>
                        </summary>
                        <div className="flex flex-wrap gap-1.5 border-t border-line px-3 py-2">
                          {grantedScopes.map((scope) => (
                            <Badge key={scope} variant="outline" className="max-w-full border-line bg-card px-2 font-mono text-[0.68rem] text-muted-foreground">
                              <span className="max-w-[220px] truncate">{formatScope(scope)}</span>
                            </Badge>
                          ))}
                        </div>
                      </details>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-foreground">Granted OAuth scopes</p>
                        <p className="text-xs text-muted-foreground">Scopes not loaded yet.</p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <AddToolControl
            existingSlugs={uniqueComposioRequirements.map((r) => r.slug.toLowerCase())}
            saving={savingAllowlist}
            onAdd={onAddConnection}
          />
        </section>
      ) : (
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Tools this worker can use</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {requiredSecrets.length > 0
                ? "This worker declares no app connections yet — it only requires the secrets listed below. Add a tool to let it call a connected app."
                : "This worker declares no app connections yet. Add a tool to let it call a connected app."}
            </p>
          </div>
          <AddToolControl existingSlugs={[]} saving={savingAllowlist} onAdd={onAddConnection} />
        </section>
      )}

      {configuredMcpConnections.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">MCP servers</h2>
          <div className="overflow-hidden rounded-lg border border-line bg-card">
            {configuredMcpConnections.map((connection) => {
              const summary = connection.transport === "stdio"
                ? [connection.command, ...(connection.args ?? [])].filter(Boolean).join(" ")
                : connection.url;
              const connected = connections.find(
                (item) =>
                  item.kind === "mcp" &&
                  ((item.mcp_label || item.app_name.replace(/^mcp:/, "")) === connection.label)
              );
              const allowedTools = connection.allowed_tools ?? connected?.mcp_allowed_tools ?? [];
              const visibleTools = allowedTools.slice(0, 6);
              const hiddenTools = Math.max(allowedTools.length - visibleTools.length, 0);
              return (
              <div key={`${connection.label}:${summary ?? ""}`} className="space-y-3 border-b border-line p-4 last:border-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{connection.label}</span>
                      <Badge variant="outline" className="border-line bg-muted text-xs">
                        {connection.transport || "streamable_http"}
                      </Badge>
                      {connected ? (
                        <Badge variant="outline" className="border-line text-xs text-muted-foreground">
                          {connected.status}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{summary}</p>
                  </div>
                  {connection.auth ? (
                    <span className="shrink-0 rounded border border-line bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                      {connection.auth}
                    </span>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-foreground">Allowed MCP tools</p>
                  {visibleTools.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {visibleTools.map((tool) => (
                        <Badge key={tool} variant="outline" className="max-w-full border-line bg-muted px-2 font-mono text-[0.68rem]">
                          <span className="max-w-[220px] truncate">{tool}</span>
                        </Badge>
                      ))}
                      {hiddenTools > 0 && (
                        <Badge variant="outline" className="border-line bg-muted px-2 text-[0.68rem] text-muted-foreground">
                          +{hiddenTools} more
                        </Badge>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No MCP tool allowlist declared.</p>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        </section>
      )}

      {requiredSecrets.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Secrets</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              API keys and tokens this worker reads from the environment. These are separate from app connections.
            </p>
          </div>
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

// ---------------------------------------------------------------------------
// Versions section
// ---------------------------------------------------------------------------

function VersionsSection({
  worker,
  onRollback,
}: {
  worker: WorkerDetail;
  onRollback: (updated: WorkerDetail) => void;
}) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<{ path: string; content: string }[] | null>(null);
  const [loadingExpand, setLoadingExpand] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState<string | null>(null);

  const currentFiles = worker.files?.map((f) => ({ path: f.path, content: f.content ?? "" })) ?? [];

  useEffect(() => {
    setLoading(true);
    api.workers
      .listVersions(worker.id)
      .then(setVersions)
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }, [worker.id]);

  async function handleExpand(v: VersionSummary) {
    if (expandedId === v.id) {
      setExpandedId(null);
      setExpandedFiles(null);
      return;
    }
    setLoadingExpand(v.id);
    try {
      const detail = await api.workers.getVersion(worker.id, v.id);
      setExpandedFiles(detail.files);
      setExpandedId(v.id);
    } catch {
      toast.error("Failed to load version");
    } finally {
      setLoadingExpand(null);
    }
  }

  async function handleRollback(v: VersionSummary) {
    setRollingBack(v.id);
    try {
      const updated = await api.workers.rollback(worker.id, v.id);
      onRollback(updated);
      const fresh = await api.workers.listVersions(worker.id);
      setVersions(fresh);
      setExpandedId(null);
      setExpandedFiles(null);
      toast.success(`Rolled back to commit ${v.sha}`);
    } catch (e: unknown) {
      toast.error(`Rollback failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setRollingBack(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 space-y-2">
        <p className="text-sm font-medium text-foreground">No versions yet</p>
        <p className="text-xs text-muted-foreground">
          Versions are saved automatically each time you update the worker&apos;s source files. Save the worker to create the first version.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {versions.length} commit{versions.length !== 1 ? "s" : ""} · newest first · click a commit to preview
      </p>
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden divide-y divide-[var(--border-default)]">
        {versions.map((v, idx) => (
          <div key={v.id}>
            <div
              className={`flex items-center justify-between gap-3 px-4 py-3 ${idx !== 0 ? "cursor-pointer hover:bg-muted/40" : ""}`}
              onClick={() => { if (idx !== 0) void handleExpand(v); }}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-xs font-mono text-muted-foreground shrink-0">
                  {v.sha}
                </span>
                <div className="min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs text-foreground max-w-[200px]" title={v.message}>{v.message}</span>
                    {idx === 0 && (
                      <span className="text-[10px] text-muted-foreground font-medium shrink-0">(current)</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {v.author} · {formatRelative(v.timestamp)}
                  </span>
                </div>
              </div>
              {idx !== 0 && (
                loadingExpand === v.id
                  ? <Skeleton className="h-4 w-4 rounded-full" />
                  : <ChevronRight className={`size-4 text-muted-foreground transition-transform ${expandedId === v.id ? "rotate-90" : ""}`} />
              )}
            </div>
            {expandedId === v.id && expandedFiles && (
              <VersionDiffPanel
                versionSha={v.sha}
                versionFiles={expandedFiles}
                currentFiles={currentFiles}
                isRestoring={rollingBack === v.id}
                onRestore={() => void handleRollback(v)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
