"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ArrowLeft, Save, FilePlus, Trash2, File, Copy } from "lucide-react";
import type { ConnectionItem, WorkerDetail, WorkerFile } from "@/lib/types";
import { CronBuilder } from "@/components/CronBuilder";
import { ConnectionEventPicker } from "@/components/ConnectionEventPicker";

type TriggerType = "manual" | "schedule" | "webhook" | "composio";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function buildTriggerYaml(
  triggerType: TriggerType,
  cronExpr: string,
  cronTimezone: string,
  composioEvent: string,
  composioConnectionId: string,
): string {
  const lines = [`trigger:`, `  type: ${triggerType}`];
  if (triggerType === "schedule") {
    lines.push(`  cron: ${yamlString(cronExpr || "0 9 * * *")}`);
    lines.push(`  timezone: ${yamlString(cronTimezone || "Europe/Berlin")}`);
  }
  if (triggerType === "webhook") {
    lines.push(`  webhook:`);
    lines.push(`    secret: true`);
    lines.push(`    allowed_methods: [POST]`);
  }
  if (triggerType === "composio") {
    lines.push(`  composio:`);
    lines.push(`    event: ${yamlString(composioEvent)}`);
    lines.push(`    connection_id: ${yamlString(composioConnectionId)}`);
    lines.push(`    filters: {}`);
  }
  return lines.join("\n");
}

function replaceTriggerBlock(yaml: string, triggerYaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^trigger:\s*$/.test(line));
  if (start === -1) return `${yaml.trimEnd()}\n\n${triggerYaml}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_][\w_-]*:\s*/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...triggerYaml.split("\n"), ...lines.slice(end)].join("\n");
}

export default function EditWorkerPage() {
  const { id } = useParams();
  const router = useRouter();
  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>("worker.yml");
  const [saving, setSaving] = useState(false);
  const [triggerType, setTriggerType] = useState<TriggerType>("manual");
  const [cronExpr, setCronExpr] = useState("0 9 * * MON");
  const [cronTimezone, setCronTimezone] = useState("Europe/Berlin");
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [composioEvent, setComposioEvent] = useState("");
  const [composioConnectionId, setComposioConnectionId] = useState("");

  // "Add file" dialog state
  const [addingFile, setAddingFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");

  useEffect(() => {
    Promise.all([
      api.workers.get(id as string),
      api.connections.list().catch(() => []),
    ]).then(([loadedWorker, connectionItems]) => {
      setWorker(loadedWorker);

      // Build editable file list from the files array
      const workerFiles = (loadedWorker.files || [])
        .filter((f: WorkerFile) => !f.binary)
        .map((f: WorkerFile) => ({ path: f.path, content: f.content || "" }));

      // Fallback: if files array is empty, use legacy fields
      if (workerFiles.length === 0) {
        const fallback: { path: string; content: string }[] = [];
        if (loadedWorker.manifest_yaml) fallback.push({ path: "worker.yml", content: loadedWorker.manifest_yaml });
        if (loadedWorker.run_py) fallback.push({ path: "run.py", content: loadedWorker.run_py });
        if (loadedWorker.skill_md_content) fallback.push({ path: "SKILL.md", content: loadedWorker.skill_md_content });
        setFiles(fallback);
      } else {
        setFiles(workerFiles);
      }

      // Default selection: worker.yml
      setSelectedPath("worker.yml");
      setTriggerType((loadedWorker.config.trigger.type as TriggerType) || "manual");
      setCronExpr(loadedWorker.config.trigger.cron || "0 9 * * MON");
      setCronTimezone(loadedWorker.config.trigger.timezone || "Europe/Berlin");
      setComposioEvent(loadedWorker.config.trigger.composio?.event || "");
      setComposioConnectionId(loadedWorker.config.trigger.composio?.connection_id || "");
      setConnections(connectionItems);
    });
  }, [id]);

  const getContent = useCallback(
    (path: string): string => {
      return files.find((f) => f.path === path)?.content || "";
    },
    [files]
  );

  const setContent = useCallback(
    (path: string, content: string) => {
      setFiles((prev) =>
        prev.map((f) => (f.path === path ? { ...f, content } : f))
      );
    },
    []
  );

  async function save() {
    if (!worker) return;
    if (triggerType === "composio" && (!composioEvent || !composioConnectionId)) {
      toast.error("Select an integration and event before saving");
      return;
    }

    setSaving(true);
    try {
      // Update trigger block inside worker.yml
      const ymlContent = getContent("worker.yml");
      const triggerYaml = buildTriggerYaml(
        triggerType,
        cronExpr,
        cronTimezone,
        composioEvent,
        composioConnectionId,
      );
      const updatedYml = replaceTriggerBlock(ymlContent, triggerYaml);

      const patchedFiles = files.map((f) =>
        f.path === "worker.yml" ? { ...f, content: updatedYml } : f
      );

      const updated = await api.workers.updateFiles(worker.id, patchedFiles);
      toast.success("Worker updated");
      router.push(`/workers/${updated.id}`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to update worker");
    } finally {
      setSaving(false);
    }
  }

  function addFile() {
    const trimmed = newFilePath.trim();
    if (!trimmed) return;
    if (files.some((f) => f.path === trimmed)) {
      toast.error(`File "${trimmed}" already exists`);
      return;
    }
    setFiles((prev) => [...prev, { path: trimmed, content: "" }]);
    setSelectedPath(trimmed);
    setNewFilePath("");
    setAddingFile(false);
  }

  function deleteFile(path: string) {
    if (path === "worker.yml") {
      toast.error("Cannot delete worker.yml");
      return;
    }
    if (!confirm(`Delete "${path}"?`)) return;
    setFiles((prev) => prev.filter((f) => f.path !== path));
    if (selectedPath === path) {
      setSelectedPath("worker.yml");
    }
  }

  if (!worker) {
    return <div className="text-sm text-[#999]">Loading...</div>;
  }

  const selectedFile = files.find((f) => f.path === selectedPath) || null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push(`/workers/${id}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit worker</h1>
          <p className="text-[#666] text-sm">{worker.name}</p>
        </div>
        <Button size="sm" onClick={save} disabled={saving}>
          <Save className="w-4 h-4 mr-1.5" />
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6 items-start">
        {/* Left: trigger config + file tree */}
        <div className="space-y-5">
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Trigger</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-sm">Type</Label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ["manual", "Manual"],
                    ["schedule", "Cron"],
                    ["webhook", "Webhook"],
                    ["composio", "Connection event"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setTriggerType(value)}
                      className={`h-8 rounded-md border px-2 text-xs font-medium whitespace-nowrap transition-colors ${
                        triggerType === value
                          ? "border-black bg-black text-white"
                          : "border-[#e4e4e7] bg-white text-[#333] hover:bg-[#f4f4f5]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {triggerType === "schedule" && (
                <div className="space-y-3">
                  <CronBuilder value={cronExpr} onChange={setCronExpr} />
                  <div className="space-y-1.5">
                    <Label className="text-xs text-[#666] uppercase tracking-wide">Timezone</Label>
                    <Input value={cronTimezone} onChange={(e) => setCronTimezone(e.target.value)} className="border-[#e4e4e7] font-mono text-sm" placeholder="Europe/Berlin" />
                  </div>
                </div>
              )}

              {triggerType === "composio" && (
                <ConnectionEventPicker
                  composioEvent={composioEvent}
                  composioConnectionId={composioConnectionId}
                  onEventChange={setComposioEvent}
                  onConnectionIdChange={setComposioConnectionId}
                  initialConnections={connections}
                />
              )}

              {triggerType === "webhook" && worker?.webhook_url && (
                <div className="space-y-2">
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
                  <pre className="text-xs font-mono bg-[#1a1a1a] text-[#a8e6a3] rounded p-2 overflow-x-auto whitespace-pre-wrap">
                    {`curl -X POST '${worker.webhook_url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"key": "value"}'`}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>

          {/* File tree */}
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader className="py-2 px-3 flex flex-row items-center justify-between">
              <CardTitle className="text-xs font-medium text-[#666]">Files</CardTitle>
              <button
                type="button"
                onClick={() => setAddingFile((v) => !v)}
                className="text-[#666] hover:text-black transition-colors"
                title="Add file"
              >
                <FilePlus className="w-3.5 h-3.5" />
              </button>
            </CardHeader>
            <CardContent className="p-0 pb-1">
              {addingFile && (
                <div className="px-3 py-2 flex gap-1.5 border-b border-[#f4f4f5]">
                  <Input
                    className="h-6 text-xs font-mono border-[#e4e4e7] py-0"
                    placeholder="lib/helpers.py"
                    value={newFilePath}
                    onChange={(e) => setNewFilePath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addFile();
                      if (e.key === "Escape") { setAddingFile(false); setNewFilePath(""); }
                    }}
                    autoFocus
                  />
                  <Button size="sm" className="h-6 px-2 text-xs" onClick={addFile}>Add</Button>
                </div>
              )}
              {files.map((f) => (
                <div
                  key={f.path}
                  className={`group flex items-center gap-1.5 px-3 py-1.5 cursor-pointer transition-colors ${
                    f.path === selectedPath
                      ? "bg-[#f4f4f5] text-black"
                      : "text-[#555] hover:bg-[#f9f9f9]"
                  }`}
                  onClick={() => setSelectedPath(f.path)}
                >
                  <File className="w-3 h-3 shrink-0 text-[#aaa]" />
                  <span className="text-xs font-mono truncate flex-1" title={f.path}>{f.path}</span>
                  {f.path !== "worker.yml" && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); deleteFile(f.path); }}
                      className="opacity-0 group-hover:opacity-100 text-[#bbb] hover:text-red-500 transition-all"
                      title={`Delete ${f.path}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Right: editor */}
        <Card className="border-[#eaeaea] shadow-none bg-white">
          <CardHeader className="py-2 px-4 border-b border-[#eaeaea]">
            <CardTitle className="text-xs font-medium font-mono text-[#555]">
              {selectedFile ? selectedFile.path : "Select a file"}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            {selectedFile ? (
              <Textarea
                key={selectedFile.path}
                value={selectedFile.content}
                onChange={(e) => setContent(selectedFile.path, e.target.value)}
                className="min-h-[640px] border-[#e4e4e7] font-mono text-xs"
                spellCheck={false}
              />
            ) : (
              <p className="text-sm text-[#999]">Select a file to edit.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
