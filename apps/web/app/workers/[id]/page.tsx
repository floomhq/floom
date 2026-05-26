"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
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
import { ArrowLeft, Play, Box, Plug, Pencil } from "lucide-react";
import type { WorkerDetail, WorkerInput, ConnectionItem } from "@/lib/types";
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
  const [toggling, setToggling] = useState(false);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);

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
      setLoading(false);
    });
  }, [id]);

  async function handlePauseToggle() {
    if (!worker) return;
    setToggling(true);
    try {
      if (worker.paused) {
        await api.workers.unpause(worker.id);
        toast.success("Worker unpaused");
      } else {
        await api.workers.pause(worker.id);
        toast.success("Worker paused");
      }
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to toggle pause");
    } finally {
      setToggling(false);
    }
  }

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

  // Compute missing connections for this worker
  const requiredConnections: string[] = worker.config.connections ?? [];
  const activeConnectionSlugs = new Set(
    connections.filter((c) => c.status === "active").map((c) => c.app_name.toLowerCase())
  );
  const missingConnections = requiredConnections.filter(
    (slug) => !activeConnectionSlugs.has(slug.toLowerCase())
  );
  const canRun = !running && !worker.paused && missingConnections.length === 0;

  return (
    <div className="space-y-6">
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
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/workers/${worker.id}/edit`}>
            <Button variant="outline" size="sm" className="border-[#e4e4e7]">
              <Pencil className="w-4 h-4 mr-1.5" />
              Edit
            </Button>
          </Link>
          {worker.paused && (
            <Badge variant="outline" className="text-gray-500 border-gray-200 bg-gray-50">Paused</Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handlePauseToggle}
            disabled={toggling}
            className={worker.paused ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50" : "border-[#e4e4e7]"}
          >
            {toggling ? "..." : worker.paused ? "Unpause" : "Pause"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
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
                  ) : inp.type === "file" && inp.accept_csv ? (
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
                  : worker.paused
                  ? "Worker paused"
                  : missingConnections.length > 0
                  ? `Connect ${missingConnections[0]} first`
                  : "Run worker"}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Recent runs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {worker.recent_runs?.length === 0 ? (
                <p className="text-sm text-[#999]">No runs yet.</p>
              ) : (
                worker.recent_runs?.map((r) => (
                  <div key={r.id} className="flex items-center justify-between p-2 rounded-md hover:bg-[#f4f4f5]">
                    <div>
                      <p className="text-sm font-medium">{r.id}</p>
                      <p className="text-xs text-[#999]">{r.created_at ? new Date(r.created_at).toLocaleString() : "—"}</p>
                    </div>
                    <Badge variant="outline">{r.status}</Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <Tabs defaultValue="config">
              <CardHeader className="pb-0">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium">Configuration</CardTitle>
                  <TabsList className="h-7 bg-[#f4f4f5]">
                    <TabsTrigger value="config" className="h-5 text-xs px-2.5">Config</TabsTrigger>
                    <TabsTrigger value="manifest" className="h-5 text-xs px-2.5">Manifest</TabsTrigger>
                  </TabsList>
                </div>
              </CardHeader>
              <TabsContent value="config">
                <CardContent className="space-y-3 text-sm pt-4">
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
                    <span className="text-[#666]">Secrets</span>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {worker.config.secrets.length === 0 ? (
                        <span className="text-xs text-[#999]">None</span>
                      ) : (
                        worker.config.secrets.map((s) => (
                          <Badge key={s} variant="secondary" className="text-xs font-normal">
                            {s}
                          </Badge>
                        ))
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="text-[#666]">Outputs</span>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {worker.config.outputs.map((o) => (
                        <Badge key={o.name} variant="outline" className="text-xs font-normal">
                          {o.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  {requiredConnections.length > 0 && (
                    <>
                      <Separator className="my-2" />
                      <div>
                        <span className="text-[#666]">Connections</span>
                        <div className="flex flex-col gap-1.5 mt-1.5">
                          {requiredConnections.map((slug) => {
                            const isActive = activeConnectionSlugs.has(slug.toLowerCase());
                            return (
                              <div key={slug} className="flex items-center justify-between">
                                <span className="text-xs capitalize">{slug}</span>
                                {isActive ? (
                                  <Badge
                                    variant="outline"
                                    className="text-xs text-emerald-600 border-emerald-200 bg-emerald-50"
                                  >
                                    Active
                                  </Badge>
                                ) : (
                                  <Badge
                                    variant="outline"
                                    className="text-xs text-amber-600 border-amber-200 bg-amber-50"
                                  >
                                    Missing
                                  </Badge>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                  {worker.config.approvals.required && (
                    <div className="flex justify-between">
                      <span className="text-[#666]">Approval</span>
                      <span className="font-medium text-amber-600">Required</span>
                    </div>
                  )}
                </CardContent>
              </TabsContent>
              <TabsContent value="manifest">
                <CardContent className="pt-4">
                  {worker.manifest_yaml ? (
                    <ManifestViewer yaml={worker.manifest_yaml} />
                  ) : (
                    <p className="text-sm text-[#999]">Manifest not available.</p>
                  )}
                </CardContent>
              </TabsContent>
            </Tabs>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ManifestViewer — syntax-highlighted YAML viewer
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
