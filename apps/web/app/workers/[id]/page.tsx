"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { ArrowLeft, Play, Box, Plug, Pencil, ClipboardCheck, File, FolderOpen, Copy } from "lucide-react";
import type { WorkerDetail, WorkerInput, WorkerFile, ConnectionItem } from "@/lib/types";
import { CsvColumnMapper } from "@/components/csv-column-mapper";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { FileInputUpload } from "@/components/FileInputUpload";

export default function WorkerDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.workers.get(id as string),
      api.connections.list(),
    ]).then(([w, conns]) => {
      setWorker(w);
      setConnections(conns);
      const defaults: Record<string, unknown> = {};
      w.config.inputs.forEach((inp: WorkerInput) => {
        if (inp.default !== undefined) defaults[inp.name] = inp.default;
        else if (inp.type === "boolean") defaults[inp.name] = false;
      });
      setInputs(defaults);
      // Default Code tab selection: SKILL.md if present, else worker.yml
      const files = w.files || [];
      const defaultFile = files.find((f) => f.path === "SKILL.md") || files.find((f) => f.path === "worker.yml") || files[0];
      if (defaultFile) setSelectedFile(defaultFile.path);
      setLoading(false);
    });
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

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!worker) {
    return <div className="text-sm text-[#999]">Worker not found.</div>;
  }

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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push("/workers")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Box className="w-5 h-5 text-[#999]" />
            {worker.name}
          </h1>
          <p className="text-[#666] text-sm">{worker.description}</p>
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {worker.folder && (
              <Badge variant="secondary" className="text-xs font-normal">{worker.folder}</Badge>
            )}
            {(worker.tags || []).map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs font-normal bg-white">{tag}</Badge>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/workers/${worker.id}/edit`}>
            <Button variant="outline" size="sm" className="border-[#e4e4e7]">
              <Pencil className="w-4 h-4 mr-1.5" />
              Edit
            </Button>
          </Link>
        </div>
      </div>

      {/* Main tabs */}
      <Tabs defaultValue="run">
        <TabsList className="h-9 bg-[#f4f4f5]">
          <TabsTrigger value="run" className="h-7 text-sm px-3">Run</TabsTrigger>
          <TabsTrigger value="code" className="h-7 text-sm px-3">Code</TabsTrigger>
          <TabsTrigger value="connections" className="h-7 text-sm px-3">Connections</TabsTrigger>
          <TabsTrigger value="runs" className="h-7 text-sm px-3">Runs</TabsTrigger>
          <TabsTrigger value="overview" className="h-7 text-sm px-3">Overview</TabsTrigger>
        </TabsList>

        {/* Run tab */}
        <TabsContent value="run" className="mt-6">
          <div className="max-w-xl space-y-4">
            <Card className="border-[#eaeaea] shadow-none bg-white">
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
                      <p className="text-xs text-[#777]">{inp.description}</p>
                    )}
                    {inp.type === "textarea" ? (
                      <Textarea
                        placeholder={inp.placeholder}
                        value={(inputs[inp.name] as string) || ""}
                        onChange={(e) => setInputs((prev) => ({ ...prev, [inp.name]: e.target.value }))}
                        className="min-h-[100px] border-[#e4e4e7]"
                      />
                    ) : inp.type === "select" ? (
                      <Select
                        value={(inputs[inp.name] as string) || (inp.default as string) || ""}
                        onValueChange={(val) => setInputs((prev) => ({ ...prev, [inp.name]: val }))}
                      >
                        <SelectTrigger className="border-[#e4e4e7]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(inp.options || []).map((opt) => (
                            <SelectItem key={opt} value={opt}>
                              {opt}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : inp.type === "boolean" ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id={`inp-${inp.name}`}
                          checked={inputs[inp.name] === true || inputs[inp.name] === "true"}
                          onChange={(e) => setInputs((prev) => ({ ...prev, [inp.name]: e.target.checked }))}
                          className="w-4 h-4 rounded border-[#e4e4e7] accent-black cursor-pointer"
                        />
                        <label htmlFor={`inp-${inp.name}`} className="text-sm text-[#666] cursor-pointer select-none">
                          {inp.placeholder || inp.label}
                        </label>
                      </div>
                    ) : inp.type === "file" && (inp as WorkerInput & { accept_csv?: boolean }).accept_csv ? (
                      <CsvColumnMapper
                        requiredColumns={worker.config.csv_required_columns || []}
                        label={undefined}
                        onMapped={(csv) => {
                          setInputs((prev) => ({ ...prev, [inp.name]: csv }));
                          setFileNames((prev) => ({ ...prev, [inp.name]: "mapped.csv" }));
                        }}
                      />
                    ) : inp.type === "file" ? (
                      <FileInputUpload
                        name={inp.name}
                        value={inputs[inp.name] as string | undefined}
                        fileName={fileNames[inp.name]}
                        accepts={(inp as WorkerInput & { accepts?: string[] }).accepts}
                        maxSizeMb={(inp as WorkerInput & { max_size_mb?: number }).max_size_mb}
                        onUploaded={(sha256, name) => {
                          setInputs((prev) => ({ ...prev, [inp.name]: sha256 }));
                          setFileNames((prev) => ({ ...prev, [inp.name]: name }));
                        }}
                      />
                    ) : (
                      <Input
                        type={inp.type === "number" ? "number" : "text"}
                        placeholder={inp.placeholder}
                        value={(inputs[inp.name] as string) || ""}
                        onChange={(e) => setInputs((prev) => ({ ...prev, [inp.name]: e.target.value }))}
                        className="border-[#e4e4e7]"
                      />
                    )}
                  </div>
                ))}

                {worker.config.inputs.length === 0 && (
                  <p className="text-sm text-[#999]">This worker has no inputs.</p>
                )}

                {worker.example_input && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={applyExampleInput}
                    disabled={!canApplySample}
                    className="border-[#e4e4e7]"
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

                <Button onClick={handleRun} disabled={!canRun} className="w-full">
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
              <Card className="border-[#eaeaea] shadow-none bg-white">
                <CardHeader>
                  <CardTitle className="text-sm font-medium">Webhook</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-[#666]">
                    Send a POST request to this URL to trigger the worker. The token authenticates the request.
                  </p>
                  <div className="space-y-1">
                    <Label className="text-xs text-[#666] uppercase tracking-wide">Webhook URL</Label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs font-mono bg-[#f4f4f5] border border-[#e4e4e7] rounded px-2 py-1.5 break-all">
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
                        className="shrink-0 p-1.5 rounded border border-[#e4e4e7] bg-white hover:bg-[#f4f4f5] transition-colors"
                      >
                        <Copy className="w-3.5 h-3.5 text-[#666]" />
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-[#666] uppercase tracking-wide">Example curl</Label>
                    <pre className="text-xs font-mono bg-[#1a1a1a] text-[#a8e6a3] rounded p-2 overflow-x-auto whitespace-pre-wrap">
                      {`curl -X POST '${worker.webhook_url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"key": "value"}'`}
                    </pre>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* Code tab */}
        <TabsContent value="code" className="mt-6">
          <WorkerFileTree
            files={worker.files || []}
            selectedPath={selectedFile}
            onSelect={setSelectedFile}
          />
        </TabsContent>

        {/* Connections tab */}
        <TabsContent value="connections" className="mt-6">
          <div className="max-w-xl space-y-6">
            {requiredConnections.length > 0 ? (
              <Card className="border-[#eaeaea] shadow-none bg-white">
                <CardHeader>
                  <CardTitle className="text-sm font-medium">Required integrations</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {requiredConnections.map((slug) => {
                    const isActive = activeConnectionSlugs.has(slug.toLowerCase());
                    return (
                      <div key={slug} className="flex items-center justify-between py-2 border-b border-[#f4f4f5] last:border-0">
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
                              <Button size="sm" variant="outline" className="h-6 text-xs border-[#e4e4e7]">
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
              <p className="text-sm text-[#999]">This worker requires no integrations.</p>
            )}

            {requiredSecrets.length > 0 && (
              <Card className="border-[#eaeaea] shadow-none bg-white">
                <CardHeader>
                  <CardTitle className="text-sm font-medium">Required secrets</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {requiredSecrets.map((s) => (
                    <div key={s} className="flex items-center justify-between py-2 border-b border-[#f4f4f5] last:border-0">
                      <span className="text-sm font-mono font-medium">{s}</span>
                      <Link href="/settings">
                        <Button size="sm" variant="outline" className="h-6 text-xs border-[#e4e4e7]">
                          Configure
                        </Button>
                      </Link>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* Runs tab */}
        <TabsContent value="runs" className="mt-6">
          <div className="max-w-2xl">
            <Card className="border-[#eaeaea] shadow-none bg-white">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Recent runs</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {worker.recent_runs?.length === 0 ? (
                  <p className="text-sm text-[#999]">No runs yet.</p>
                ) : (
                  worker.recent_runs?.map((r) => (
                    <Link key={r.id} href={`/runs/${r.id}`}>
                      <div className="flex items-center justify-between p-2 rounded-md hover:bg-[#f4f4f5] cursor-pointer">
                        <div>
                          <p className="text-sm font-medium font-mono">{r.id}</p>
                          <p className="text-xs text-[#999]">{r.created_at ? new Date(r.created_at).toLocaleString() : "-"}</p>
                        </div>
                        <Badge variant="outline">{r.status}</Badge>
                      </div>
                    </Link>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Overview tab */}
        <TabsContent value="overview" className="mt-6">
          <div className="max-w-2xl space-y-6">
            {/* Worker metadata */}
            <Card className="border-[#eaeaea] shadow-none bg-white">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Configuration</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-[#666]">Trigger</span>
                  <span className="font-medium">{worker.config.trigger.type}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#666]">Runtime</span>
                  <span className="font-medium">{worker.config.runtime.type}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#666]">Runner</span>
                  <span className="font-medium">{worker.config.runtime.runner}</span>
                </div>
                <Separator className="my-2" />
                <div>
                  <span className="text-[#666]">Inputs</span>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {worker.config.inputs.length === 0 ? (
                      <span className="text-xs text-[#999]">None</span>
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
                  <span className="text-[#666]">Outputs</span>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {worker.config.outputs.length === 0 ? (
                      <span className="text-xs text-[#999]">None</span>
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

            {/* Long description + use cases + example + how it works */}
            {(worker.long_description || worker.use_cases?.length || worker.example_input || worker.example_output || worker.how_it_works) && (
              <Card className="border-[#eaeaea] shadow-none bg-white">
                <CardHeader>
                  <CardTitle className="text-sm font-medium">Worker guide</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  {worker.long_description && (
                    <section>
                      <h2 className="text-sm font-medium mb-2">Description</h2>
                      <p className="text-sm text-[#666] leading-relaxed whitespace-pre-wrap">{worker.long_description}</p>
                    </section>
                  )}

                  {worker.use_cases && worker.use_cases.length > 0 && (
                    <section>
                      <h2 className="text-sm font-medium mb-2">Use cases</h2>
                      <ul className="list-disc pl-5 space-y-1">
                        {worker.use_cases.map((useCase) => (
                          <li key={useCase} className="text-sm text-[#666]">{useCase}</li>
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
                          onClick={applyExampleInput}
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
                      <pre className="text-xs leading-relaxed overflow-auto font-mono bg-[#f4f4f5] p-3 rounded-md border border-[#eaeaea] whitespace-pre-wrap">
                        {worker.how_it_works}
                      </pre>
                    </section>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

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
    return <p className="text-sm text-[#999]">This worker has no manual inputs.</p>;
  }

  return (
    <div className="rounded-md border border-[#eaeaea] overflow-hidden">
      {entries.map((entry) => (
        <div key={entry.name} className="grid grid-cols-1 md:grid-cols-[180px_minmax(0,1fr)] border-b border-[#eaeaea] last:border-b-0">
          <div className="bg-[#fafafa] px-3 py-2">
            <p className="text-xs font-medium text-[#555]">{entry.label}</p>
            <p className="text-[11px] text-[#999] font-mono">{entry.name} · {entry.type}</p>
          </div>
          <div className="px-3 py-2">
            <pre className={`text-xs font-mono whitespace-pre-wrap break-words ${entry.value === null && entry.type === "file" ? "text-[#999] italic" : "text-[#333]"}`}>
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
    <div className="prose prose-sm max-w-none text-[#333] bg-[#fafafa] p-4 rounded-md border border-[#eaeaea]">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {value}
      </ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkerFileTree: file tree + viewer for the Code tab
// ---------------------------------------------------------------------------

function WorkerFileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: WorkerFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const selected = files.find((f) => f.path === selectedPath) || null;

  if (files.length === 0) {
    return <p className="text-sm text-[#999]">No files found for this worker.</p>;
  }

  return (
    <div className="flex gap-4 items-start max-w-5xl">
      {/* Left: file list */}
      <div className="w-52 shrink-0">
        <Card className="border-[#eaeaea] shadow-none bg-white">
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-xs font-medium text-[#666] flex items-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5" />
              Files
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-1">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => onSelect(f.path)}
                className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate flex items-center gap-1.5 transition-colors ${
                  f.path === selectedPath
                    ? "bg-[#f4f4f5] text-black font-semibold"
                    : "text-[#555] hover:bg-[#f9f9f9]"
                }`}
                title={f.path}
              >
                <File className="w-3 h-3 shrink-0 text-[#aaa]" />
                <span className="truncate">{f.path}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Right: content viewer */}
      <div className="flex-1 min-w-0">
        {selected ? (
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader className="py-2 px-4 border-b border-[#eaeaea]">
              <CardTitle className="text-xs font-medium font-mono text-[#555]">{selected.path}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {selected.binary ? (
                <div className="p-4 text-sm text-[#999]">Binary file — cannot display.</div>
              ) : selected.language === "markdown" ? (
                <div className="prose prose-sm max-w-none text-[#333] bg-[#fafafa] p-4 rounded-b-md overflow-auto max-h-[600px]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {selected.content || ""}
                  </ReactMarkdown>
                </div>
              ) : selected.language === "yaml" ? (
                <div className="overflow-auto max-h-[600px] p-3 bg-[#f9f9f9] rounded-b-md">
                  <ManifestViewer yaml={selected.content || ""} />
                </div>
              ) : (
                <pre className="text-xs font-mono overflow-auto max-h-[600px] bg-[#f9f9f9] p-3 rounded-b-md whitespace-pre">
                  {selected.content || ""}
                </pre>
              )}
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-[#999]">Select a file to view.</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ManifestViewer: syntax-highlighted YAML viewer
// ---------------------------------------------------------------------------

function ManifestViewer({ yaml }: { yaml: string }) {
  const lines = yaml.split("\n");
  return (
    <pre className="text-xs leading-relaxed overflow-auto max-h-[400px] font-mono bg-[#f9f9f9] p-3 rounded-md">
      {lines.map((line, i) => {
        const keyMatch = line.match(/^(\s*)([\w_-]+):\s*(.*)$/);
        if (keyMatch) {
          const [, indent, key, value] = keyMatch;
          return (
            <div key={i}>
              {indent}
              <span style={{ color: "var(--ink-soft)" }}>{key}</span>
              <span style={{ color: "var(--ink-mute)" }}>: </span>
              <span style={{ color: "var(--ink)" }}>{value}</span>
            </div>
          );
        }
        const listMatch = line.match(/^(\s*-\s*)(.*)$/);
        if (listMatch) {
          const [, prefix, rest] = listMatch;
          return (
            <div key={i}>
              <span style={{ color: "var(--ink-mute)" }}>{prefix}</span>
              <span style={{ color: "var(--ink)" }}>{rest}</span>
            </div>
          );
        }
        return <div key={i}>{line || " "}</div>;
      })}
    </pre>
  );
}
