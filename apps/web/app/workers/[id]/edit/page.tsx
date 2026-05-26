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
import { ArrowLeft, Save, FilePlus, Trash2, File, Copy, Plus, X } from "lucide-react";
import type { ConnectionItem, TriggerSpec, WorkerDetail, WorkerFile } from "@/lib/types";
import { CronBuilder } from "@/components/CronBuilder";
import { ConnectionEventPicker } from "@/components/ConnectionEventPicker";

type TriggerType = "manual" | "schedule" | "webhook" | "composio";

// ---------------------------------------------------------------------------
// Per-trigger row state (richer than TriggerSpec for local editing)
// ---------------------------------------------------------------------------

interface TriggerRow {
  id: string; // local unique key for React
  type: TriggerType;
  cronExpr: string;
  cronTimezone: string;
  composioEvent: string;
  composioConnectionId: string;
}

function makeTriggerRow(spec?: TriggerSpec): TriggerRow {
  return {
    id: Math.random().toString(36).slice(2),
    type: ((spec?.type as TriggerType) || "manual"),
    cronExpr: spec?.cron || "0 9 * * MON",
    cronTimezone: spec?.timezone || "Europe/Berlin",
    composioEvent: spec?.composio?.event || "",
    composioConnectionId: spec?.composio?.connection_id || "",
  };
}

function defaultTriggerRow(): TriggerRow {
  return makeTriggerRow(undefined);
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function buildSingleTriggerYaml(row: TriggerRow): string {
  const lines = [`  - type: ${row.type}`];
  if (row.type === "schedule") {
    lines.push(`    cron: ${yamlString(row.cronExpr || "0 9 * * *")}`);
    lines.push(`    timezone: ${yamlString(row.cronTimezone || "Europe/Berlin")}`);
  }
  if (row.type === "webhook") {
    lines.push(`    webhook:`);
    lines.push(`      secret: true`);
    lines.push(`      allowed_methods: [POST]`);
  }
  if (row.type === "composio") {
    lines.push(`    composio:`);
    lines.push(`      event: ${yamlString(row.composioEvent)}`);
    lines.push(`      connection_id: ${yamlString(row.composioConnectionId)}`);
    lines.push(`      filters: {}`);
  }
  return lines.join("\n");
}

function buildTriggersYaml(rows: TriggerRow[]): string {
  if (rows.length === 1) {
    // Use singular `trigger:` for backward compat with single-trigger workers
    const row = rows[0];
    const lines = [`trigger:`, `  type: ${row.type}`];
    if (row.type === "schedule") {
      lines.push(`  cron: ${yamlString(row.cronExpr || "0 9 * * *")}`);
      lines.push(`  timezone: ${yamlString(row.cronTimezone || "Europe/Berlin")}`);
    }
    if (row.type === "webhook") {
      lines.push(`  webhook:`);
      lines.push(`    secret: true`);
      lines.push(`    allowed_methods: [POST]`);
    }
    if (row.type === "composio") {
      lines.push(`  composio:`);
      lines.push(`    event: ${yamlString(row.composioEvent)}`);
      lines.push(`    connection_id: ${yamlString(row.composioConnectionId)}`);
      lines.push(`    filters: {}`);
    }
    return lines.join("\n");
  }

  // Multi-trigger: use `triggers:` array
  const lines = [`triggers:`];
  for (const row of rows) {
    lines.push(buildSingleTriggerYaml(row));
  }
  return lines.join("\n");
}

/**
 * Replace the trigger block (either `trigger:` or `triggers:`) in the full
 * YAML string. Handles both singular and array forms.
 */
function replaceTriggerBlock(yaml: string, triggerYaml: string): string {
  const lines = yaml.split("\n");

  // Find `trigger:` or `triggers:` at root level
  const start = lines.findIndex((line) =>
    /^triggers?:\s*$/.test(line)
  );

  if (start === -1) {
    // No trigger block found — append
    return `${yaml.trimEnd()}\n\n${triggerYaml}\n`;
  }

  // Find end of trigger block: next root-level key
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_][\w_-]*:\s*/.test(lines[i])) {
      end = i;
      break;
    }
  }

  return [
    ...lines.slice(0, start),
    ...triggerYaml.split("\n"),
    ...lines.slice(end),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// TriggerRowEditor component
// ---------------------------------------------------------------------------

interface TriggerRowEditorProps {
  row: TriggerRow;
  index: number;
  total: number;
  connections: ConnectionItem[];
  webhookUrl?: string;
  onChange: (updated: TriggerRow) => void;
  onRemove: () => void;
}

function TriggerRowEditor({
  row,
  index,
  total,
  connections,
  webhookUrl,
  onChange,
  onRemove,
}: TriggerRowEditorProps) {
  const isOnly = total === 1;

  return (
    <div className="rounded-md border border-[#e4e4e7] bg-[#fafafa] p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[#666] uppercase tracking-wide">
          Trigger {total > 1 ? index + 1 : ""}
        </span>
        {!isOnly && (
          <button
            type="button"
            onClick={onRemove}
            className="text-[#bbb] hover:text-red-500 transition-colors"
            title="Remove trigger"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(["manual", "schedule", "webhook", "composio"] as const).map((value) => {
          const labels: Record<string, string> = {
            manual: "Manual",
            schedule: "Cron",
            webhook: "Webhook",
            composio: "Connection event",
          };
          return (
            <button
              key={value}
              type="button"
              onClick={() => onChange({ ...row, type: value })}
              className={`h-8 rounded-md border px-2 text-xs font-medium whitespace-nowrap transition-colors ${
                row.type === value
                  ? "border-black bg-black text-white"
                  : "border-[#e4e4e7] bg-white text-[#333] hover:bg-[#f4f4f5]"
              }`}
            >
              {labels[value]}
            </button>
          );
        })}
      </div>

      {row.type === "schedule" && (
        <div className="space-y-3">
          <CronBuilder
            value={row.cronExpr}
            onChange={(v) => onChange({ ...row, cronExpr: v })}
          />
          <div className="space-y-1.5">
            <Label className="text-xs text-[#666] uppercase tracking-wide">Timezone</Label>
            <Input
              value={row.cronTimezone}
              onChange={(e) => onChange({ ...row, cronTimezone: e.target.value })}
              className="border-[#e4e4e7] font-mono text-sm"
              placeholder="Europe/Berlin"
            />
          </div>
        </div>
      )}

      {row.type === "composio" && (
        <ConnectionEventPicker
          composioEvent={row.composioEvent}
          composioConnectionId={row.composioConnectionId}
          onEventChange={(v) => onChange({ ...row, composioEvent: v })}
          onConnectionIdChange={(v) => onChange({ ...row, composioConnectionId: v })}
          initialConnections={connections}
        />
      )}

      {row.type === "webhook" && webhookUrl && (
        <div className="space-y-2">
          <Label className="text-xs text-[#666] uppercase tracking-wide">Webhook URL</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-[#f4f4f5] border border-[#e4e4e7] rounded px-2 py-1.5 break-all">
              {webhookUrl}
            </code>
            <button
              type="button"
              title="Copy URL"
              onClick={() => {
                navigator.clipboard.writeText(webhookUrl).then(
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
            {`curl -X POST '${webhookUrl}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"key": "value"}'`}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function EditWorkerPage() {
  const { id } = useParams();
  const router = useRouter();
  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>("worker.yml");
  const [saving, setSaving] = useState(false);
  const [triggerRows, setTriggerRows] = useState<TriggerRow[]>([defaultTriggerRow()]);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);

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

      // Populate trigger rows from triggers_spec (multi-trigger) or config.trigger (legacy)
      const specs: TriggerSpec[] = loadedWorker.triggers_spec?.length
        ? loadedWorker.triggers_spec
        : [loadedWorker.config.trigger];

      setTriggerRows(specs.map((s) => makeTriggerRow(s)));
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

  function updateTriggerRow(index: number, updated: TriggerRow) {
    setTriggerRows((prev) => prev.map((r, i) => (i === index ? updated : r)));
  }

  function addTriggerRow() {
    setTriggerRows((prev) => [...prev, defaultTriggerRow()]);
  }

  function removeTriggerRow(index: number) {
    setTriggerRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function save() {
    if (!worker) return;

    // Validate composio rows
    for (const row of triggerRows) {
      if (row.type === "composio" && (!row.composioEvent || !row.composioConnectionId)) {
        toast.error("Select an integration and event for every connection-event trigger");
        return;
      }
    }

    setSaving(true);
    try {
      const ymlContent = getContent("worker.yml");
      const triggerYaml = buildTriggersYaml(triggerRows);
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
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Triggers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {triggerRows.map((row, index) => (
                <TriggerRowEditor
                  key={row.id}
                  row={row}
                  index={index}
                  total={triggerRows.length}
                  connections={connections}
                  webhookUrl={
                    row.type === "webhook" ? worker.webhook_url : undefined
                  }
                  onChange={(updated) => updateTriggerRow(index, updated)}
                  onRemove={() => removeTriggerRow(index)}
                />
              ))}
              <button
                type="button"
                onClick={addTriggerRow}
                className="flex items-center gap-1.5 text-xs text-[#666] hover:text-black transition-colors py-1"
              >
                <Plus className="w-3.5 h-3.5" />
                Add trigger
              </button>
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
