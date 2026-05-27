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
  ArrowLeft, Play, Box, Plug, Pencil, ClipboardCheck, ChevronRight,
  File, FolderOpen, Copy, Play as PlayIcon, Code2, Clock, Plug2, ListChecks, Info,
} from "lucide-react";
import type { WorkerDetail, WorkerInput, WorkerFile, ConnectionItem, TriggerSpec } from "@/lib/types";
import { CsvColumnMapper } from "@/components/csv-column-mapper";
import { FileInputUpload } from "@/components/FileInputUpload";
import { FilesEditor, TriggersEditor, makeTriggerRow, buildTriggersYaml, replaceTriggerBlock } from "@/components/worker-form";
import type { TriggerRow } from "@/components/worker-form";
import { formatRelativeTime } from "@/components/connections/connection-data";

// ---------------------------------------------------------------------------
// Section types and nav config
// ---------------------------------------------------------------------------

type Section = "run" | "code" | "triggers" | "connections" | "runs" | "overview";

interface NavItem {
  id: Section;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: "run", label: "Run", icon: <Play className="w-4 h-4" /> },
  { id: "code", label: "Code", icon: <Code2 className="w-4 h-4" /> },
  { id: "triggers", label: "Triggers", icon: <Clock className="w-4 h-4" /> },
  { id: "connections", label: "Connections", icon: <Plug2 className="w-4 h-4" /> },
  { id: "runs", label: "Runs", icon: <ListChecks className="w-4 h-4" /> },
  { id: "overview", label: "Overview", icon: <Info className="w-4 h-4" /> },
];

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function WorkerDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();

  const sectionParam = (searchParams.get("section") as Section) || "run";
  const [activeSection, setActiveSection] = useState<Section>(sectionParam);

  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Triggers edit state
  const [triggerRows, setTriggerRows] = useState<TriggerRow[]>([]);
  const [savingTriggers, setSavingTriggers] = useState(false);
  const [triggersDirty, setTriggersDirty] = useState(false);

  const setSection = useCallback((s: Section) => {
    setActiveSection(s);
    const url = new URL(window.location.href);
    url.searchParams.set("section", s);
    window.history.replaceState(null, "", url.toString());
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
      toast.success("Run started");
      router.push(`/runs/${result.run_id}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to start run");
    } finally {
      setRunning(false);
    }
  }

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
    return (
      <div className="flex gap-0">
        {/* Rail skeleton */}
        <div className="w-[180px] shrink-0 border-r border-border min-h-screen">
          <div className="p-3 space-y-1">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-8 w-full rounded" />
            ))}
          </div>
        </div>
        {/* Content skeleton */}
        <div className="flex-1 p-6 space-y-4">
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-4 w-72" />
          <div className="max-w-xl space-y-3 mt-4">
            <div className="rounded-lg border border-border bg-card p-5 space-y-3">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
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
    <div className="space-y-6">
      {/* Worker header */}
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push("/workers")} className="shrink-0 mt-0.5">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Box className="w-5 h-5 text-muted-foreground shrink-0" />
            {worker.name}
            <span
              className={`size-2 rounded-full shrink-0 ${
                worker.status === "healthy"
                  ? "bg-emerald-500"
                  : worker.status === "error"
                  ? "bg-red-500"
                  : "bg-amber-500"
              }`}
              title={worker.status.replace("_", " ")}
            />
          </h1>
          {worker.description && (
            <p className="text-muted-foreground text-sm mt-0.5">{worker.description}</p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {worker.folder && (
              <Badge variant="secondary" className="text-xs font-normal">{worker.folder}</Badge>
            )}
            {(worker.tags || []).map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs font-normal">{tag}</Badge>
            ))}
            {lastRunAt && (
              <span className="text-xs text-muted-foreground">· Last run {formatRelativeTime(lastRunAt)}</span>
            )}
          </div>
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
        {activeSection === "run" && (
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
          />
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
          <div className="max-w-xl space-y-4">
            <TriggersEditor
              rows={triggerRows}
              onChange={(rows) => {
                setTriggerRows(rows);
                setTriggersDirty(true);
              }}
              connections={connections}
              webhookUrl={worker.webhook_url}
            />
            {triggersDirty && (
              <div className="flex items-center gap-2">
                <Button onClick={handleSaveTriggers} disabled={savingTriggers} size="sm">
                  {savingTriggers ? "Saving..." : "Save triggers"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const specs: TriggerSpec[] = worker.triggers_spec || [];
                    if (specs.length > 0) {
                      setTriggerRows(specs.map((s) => makeTriggerRow(s)));
                    } else if (worker.config.trigger) {
                      setTriggerRows([makeTriggerRow(worker.config.trigger as TriggerSpec)]);
                    }
                    setTriggersDirty(false);
                  }}
                >
                  Discard
                </Button>
              </div>
            )}
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

        {activeSection === "overview" && (
          <OverviewSection worker={worker} canApplySample={canApplySample} onApplySample={applyExampleInput} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run section
// ---------------------------------------------------------------------------

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
}) {
  return (
    <div className="max-w-xl space-y-4">
      <Card className="border-border shadow-none bg-card">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Run worker</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {worker.config.inputs.map((inp: WorkerInput) => (
            <div key={inp.name} className="space-y-1.5">
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
                  <SelectTrigger className="border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(inp.options || []).map((opt) => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
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

          {worker.config.inputs.length === 0 && (
            <p className="text-sm text-muted-foreground">This worker has no inputs.</p>
          )}

          {worker.example_input && (
            <Button
              variant="outline"
              size="sm"
              onClick={onApplySample}
              disabled={!canApplySample}
              className="border-border"
            >
              <ClipboardCheck className="w-3.5 h-3.5 mr-1.5" />
              Use sample input
            </Button>
          )}

          {missingConnections.length > 0 && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800">
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
        </CardContent>
      </Card>

      {worker.webhook_url && (
        <Card className="border-border shadow-none bg-card">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Webhook</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Send a POST request to this URL to trigger the worker. The token authenticates the request.
            </p>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">Webhook URL</Label>
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
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">Example curl</Label>
              <pre className="text-xs font-mono bg-[#1a1a1a] text-[#a8e6a3] rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {`curl -X POST '${worker.webhook_url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"key": "value"}'`}
              </pre>
            </div>
          </CardContent>
        </Card>
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
  return (
    <div className="max-w-xl space-y-6">
      {requiredConnections.length > 0 ? (
        <Card className="border-border shadow-none bg-card">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Required integrations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {requiredConnections.map((slug) => {
              const isActive = activeConnectionSlugs.has(slug.toLowerCase());
              return (
                <div key={slug} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <span className="text-sm capitalize font-medium">{slug}</span>
                  {isActive ? (
                    <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-200 bg-emerald-50">
                      Active
                    </Badge>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs text-amber-600 border-amber-200 bg-amber-50">
                        Missing
                      </Badge>
                      <Link href="/connections">
                        <Button size="sm" variant="outline" className="h-6 text-xs border-border">
                          Connect
                        </Button>
                      </Link>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">This worker requires no integrations.</p>
      )}

      {requiredSecrets.length > 0 && (
        <Card className="border-border shadow-none bg-card">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Required secrets</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {requiredSecrets.map((s) => (
              <div key={s} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <span className="text-sm font-mono font-medium">{s}</span>
                <Link href="/settings">
                  <Button size="sm" variant="outline" className="h-6 text-xs border-border">
                    Configure
                  </Button>
                </Link>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runs section
// ---------------------------------------------------------------------------

function RunsSection({ worker }: { worker: WorkerDetail }) {
  return (
    <div className="max-w-2xl">
      <Card className="border-border shadow-none bg-card">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Recent runs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {worker.recent_runs?.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            worker.recent_runs?.map((r) => (
              <Link key={r.id} href={`/runs/${r.id}`}>
                <div className="flex items-center justify-between p-2 rounded-md hover:bg-muted cursor-pointer transition-colors">
                  <div>
                    <p className="text-sm font-medium">{r.worker_name || r.id}</p>
                    <p className="text-xs text-muted-foreground font-mono">{r.id}</p>
                    <p className="text-xs text-muted-foreground">{r.created_at ? new Date(r.created_at).toLocaleString() : "-"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{r.status}</Badge>
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                </div>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview section
// ---------------------------------------------------------------------------

function OverviewSection({
  worker,
  canApplySample,
  onApplySample,
}: {
  worker: WorkerDetail;
  canApplySample: boolean;
  onApplySample: () => void;
}) {
  return (
    <div className="max-w-2xl space-y-6">
      <Card className="border-border shadow-none bg-card">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Trigger</span>
            <span className="font-medium">{worker.config.trigger.type}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Runtime</span>
            <span className="font-medium">{worker.config.runtime.type}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Runner</span>
            <span className="font-medium">{worker.config.runtime.runner}</span>
          </div>
          <Separator className="my-2" />
          <div>
            <span className="text-muted-foreground">Inputs</span>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {worker.config.inputs.length === 0 ? (
                <span className="text-xs text-muted-foreground">None</span>
              ) : (
                worker.config.inputs.map((inp) => (
                  <Badge key={inp.name} variant="secondary" className="text-xs font-normal">
                    {inp.label || inp.name}
                  </Badge>
                ))
              )}
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Outputs</span>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {worker.config.outputs.length === 0 ? (
                <span className="text-xs text-muted-foreground">None</span>
              ) : (
                worker.config.outputs.map((o) => (
                  <Badge key={o.name} variant="outline" className="text-xs font-normal">
                    {o.label}
                  </Badge>
                ))
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {(worker.long_description || worker.use_cases?.length || worker.example_input || worker.example_output || worker.how_it_works) && (
        <Card className="border-border shadow-none bg-card">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Worker guide</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {worker.long_description && (
              <section>
                <h2 className="text-sm font-medium mb-2">Description</h2>
                <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">{worker.long_description}</p>
              </section>
            )}

            {worker.use_cases && worker.use_cases.length > 0 && (
              <section>
                <h2 className="text-sm font-medium mb-2">Use cases</h2>
                <ul className="list-disc pl-5 space-y-1">
                  {worker.use_cases.map((useCase) => (
                    <li key={useCase} className="text-sm text-muted-foreground">{useCase}</li>
                  ))}
                </ul>
              </section>
            )}

            {worker.example_input && (
              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium">Example input</h2>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={onApplySample}
                    disabled={!canApplySample}
                  >
                    <ClipboardCheck className="w-3.5 h-3.5 mr-1.5" />
                    Use this sample
                  </Button>
                </div>
                <ExampleInputPreview inputs={worker.config.inputs} example={worker.example_input} />
              </section>
            )}

            {worker.example_output && (
              <section>
                <h2 className="text-sm font-medium mb-2">Example output</h2>
                <MarkdownPreview value={worker.example_output} />
              </section>
            )}

            {worker.how_it_works && (
              <section>
                <h2 className="text-sm font-medium mb-2">How it works</h2>
                <pre className="text-xs leading-relaxed overflow-auto font-mono bg-muted p-3 rounded-md border border-border whitespace-pre-wrap">
                  {worker.how_it_works}
                </pre>
              </section>
            )}
          </CardContent>
        </Card>
      )}

      <DangerZone workerId={worker.id} workerName={worker.name} />
    </div>
  );
}

function DangerZone({ workerId, workerName }: { workerId: string; workerName: string }) {
  // PR S19 (I-5): the only way to delete a worker. Type-to-confirm guard
  // because there's no undo and deleting also cancels any running runs.
  const router = useRouter();
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const canDelete = confirmText.trim() === workerName.trim();

  async function handleDelete() {
    if (!canDelete) return;
    setDeleting(true);
    try {
      await api.workers.delete(workerId);
      toast.success(`Deleted ${workerName}`);
      router.push("/workers");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete worker");
      setDeleting(false);
    }
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-sm font-medium text-destructive">Danger zone</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Deleting a worker cancels in-flight runs and removes its bundle, runs,
          and configured triggers. There is no undo.
        </p>
        <div className="space-y-2">
          <Label htmlFor="delete-confirm" className="text-xs text-muted-foreground">
            Type <code className="text-foreground">{workerName}</code> to confirm.
          </Label>
          <Input
            id="delete-confirm"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={workerName}
            className="max-w-sm"
          />
        </div>
        <Button
          variant="destructive"
          size="sm"
          disabled={!canDelete || deleting}
          onClick={() => void handleDelete()}
        >
          {deleting ? "Deleting..." : "Delete worker"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function ExampleInputPreview({
  inputs,
  example,
}: {
  inputs: WorkerInput[];
  example: Record<string, unknown>;
}) {
  const entries = inputs.length > 0
    ? inputs.map((input) => ({
        name: input.name,
        label: input.label,
        type: input.type,
        value: example[input.name],
      }))
    : Object.entries(example).map(([name, value]) => ({
        name,
        label: name.replace(/_/g, " "),
        type: typeof value,
        value,
      }));

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">This worker has no manual inputs.</p>;
  }

  return (
    <div className="rounded-md border border-border overflow-hidden">
      {entries.map((entry) => (
        <div key={entry.name} className="grid grid-cols-1 md:grid-cols-[180px_minmax(0,1fr)] border-b border-border last:border-b-0">
          <div className="bg-muted/30 px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">{entry.label}</p>
            <p className="text-[11px] text-muted-foreground font-mono">{entry.name} · {entry.type}</p>
          </div>
          <div className="px-3 py-2">
            <pre className={`text-xs font-mono whitespace-pre-wrap break-words ${entry.value === null && entry.type === "file" ? "text-muted-foreground italic" : "text-foreground"}`}>
              {formatExampleValue(entry.value, entry.type)}
            </pre>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatExampleValue(value: unknown, type?: string): string {
  if (value === undefined) return "";
  if (value === null) {
    return type === "file" ? "(no sample file, upload one)" : "null";
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function MarkdownPreview({ value }: { value: string }) {
  return (
    <div className="prose prose-sm max-w-none text-foreground bg-muted/30 p-4 rounded-md border border-border">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {value}
      </ReactMarkdown>
    </div>
  );
}
