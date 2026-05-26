"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { ArrowLeft, Save } from "lucide-react";
import type { ConnectionItem, TriggerSpec, WorkerDetail, WorkerFile } from "@/lib/types";
import {
  ExecModePicker,
  FilesEditor,
  TriggersEditor,
  WorkerMetadataForm,
  buildTriggersYaml,
  defaultTriggerRow,
  makeTriggerRow,
  replaceTriggerBlock,
} from "@/components/worker-form";
import type { ExecMode, TriggerRow } from "@/components/worker-form";

// ---------------------------------------------------------------------------
// Derive exec mode from the worker YAML / config
// ---------------------------------------------------------------------------

function deriveExecMode(worker: WorkerDetail): ExecMode {
  const yaml = worker.manifest_yaml || "";
  if (/mode:\s*pure-script/i.test(yaml)) return "pure-script";
  if (/mode:\s*hybrid/i.test(yaml)) return "hybrid";
  if (/mode:\s*agent/i.test(yaml)) return "agent";
  const files = worker.files || [];
  const hasSkillMd = files.some((f) => f.path === "SKILL.md");
  const hasRunPy = files.some((f) => f.path === "run.py");
  if (hasSkillMd && !hasRunPy) return "agent";
  if (hasRunPy && !hasSkillMd) return "pure-script";
  return "agent";
}

// ---------------------------------------------------------------------------
// Replace exec block helper
// ---------------------------------------------------------------------------

function buildExecModeYamlFragment(mode: ExecMode): string {
  if (mode === "agent") {
    return `exec:\n  runtime: skill\n  mode: agent\n  runner: e2b\n  entrypoint: SKILL.md`;
  }
  if (mode === "pure-script") {
    return `exec:\n  command: python run.py\n  runtime: python311\n  mode: pure-script\n  runner: e2b`;
  }
  return `exec:\n  command: python run.py\n  runtime: python311\n  mode: hybrid\n  runner: e2b\n  entrypoint: run.py`;
}

function replaceExecBlock(yaml: string, execYaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^exec:\s*$/.test(line));
  if (start === -1) return `${yaml.trimEnd()}\n\n${execYaml}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_][\w_-]*:\s*/.test(lines[i])) { end = i; break; }
  }
  return [...lines.slice(0, start), ...execYaml.split("\n"), ...lines.slice(end)].join("\n");
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function EditSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-8 rounded" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-7 w-52" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-8 w-20 rounded" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6">
        <div className="space-y-4">
          {[120, 200, 180, 150].map((h, i) => (
            <Skeleton key={i} className="w-full rounded-md" style={{ height: h }} />
          ))}
        </div>
        <Skeleton className="w-full rounded-md" style={{ height: 640 }} />
      </div>
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
  const [loading, setLoading] = useState(true);

  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [originalContents, setOriginalContents] = useState<Record<string, string>>({});
  const [selectedPath, setSelectedPath] = useState<string>("worker.yml");

  const [triggerRows, setTriggerRows] = useState<TriggerRow[]>([defaultTriggerRow()]);
  const [execMode, setExecMode] = useState<ExecMode>("agent");
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.workers.get(id as string),
      api.connections.list().catch(() => [] as ConnectionItem[]),
    ]).then(([loadedWorker, connectionItems]) => {
      setWorker(loadedWorker);

      const workerFiles = (loadedWorker.files || [])
        .filter((f: WorkerFile) => !f.binary)
        .map((f: WorkerFile) => ({ path: f.path, content: f.content || "" }));

      let resolvedFiles: { path: string; content: string }[];
      if (workerFiles.length === 0) {
        const fallback: { path: string; content: string }[] = [];
        if (loadedWorker.manifest_yaml) fallback.push({ path: "worker.yml", content: loadedWorker.manifest_yaml });
        if (loadedWorker.run_py) fallback.push({ path: "run.py", content: loadedWorker.run_py });
        if (loadedWorker.skill_md_content) fallback.push({ path: "SKILL.md", content: loadedWorker.skill_md_content });
        resolvedFiles = fallback;
      } else {
        resolvedFiles = workerFiles;
      }

      setFiles(resolvedFiles);
      const snap: Record<string, string> = {};
      for (const f of resolvedFiles) snap[f.path] = f.content;
      setOriginalContents(snap);
      setSelectedPath("worker.yml");

      const specs: TriggerSpec[] = loadedWorker.triggers_spec?.length
        ? loadedWorker.triggers_spec
        : [loadedWorker.config.trigger];
      setTriggerRows(specs.map((s) => makeTriggerRow(s)));
      setExecMode(deriveExecMode(loadedWorker));
      setConnections(connectionItems);
      setLoading(false);
    }).catch((e) => {
      toast.error(e instanceof Error ? e.message : "Failed to load worker");
      setLoading(false);
    });
  }, [id]);

  const getContent = useCallback(
    (path: string): string => files.find((f) => f.path === path)?.content || "",
    [files]
  );

  const isDirty = files.some((f) => f.content !== (originalContents[f.path] ?? ""));

  function navigateAway(path: string) {
    if (isDirty && !confirm("Discard unsaved changes?")) return;
    router.push(path);
  }

  async function save() {
    if (!worker) return;

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
      let updatedYml = replaceTriggerBlock(ymlContent, triggerYaml);
      updatedYml = replaceExecBlock(updatedYml, buildExecModeYamlFragment(execMode));

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

  if (loading || !worker) {
    return <EditSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigateAway(`/workers/${id}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Edit worker</h1>
            {isDirty && (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                Unsaved changes
              </span>
            )}
          </div>
          <p className="text-[#666] text-sm">{worker.name}</p>
        </div>
        <Button size="sm" onClick={save} disabled={saving || !isDirty}>
          <Save className="w-4 h-4 mr-1.5" />
          {saving ? "Saving..." : isDirty ? "Save" : "Saved"}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6 items-start">
        {/* Left column: form sections (metadata, triggers, mode) */}
        <div className="space-y-5">
          <WorkerMetadataForm
            mode="edit"
            values={{
              workerId: worker.id,
              name: worker.name,
              description: worker.description,
            }}
            onChange={() => {
              // Name/description are reflected in the YAML directly via the editor.
              // This panel is informational in edit mode.
            }}
          />

          <TriggersEditor
            rows={triggerRows}
            onChange={setTriggerRows}
            connections={connections}
            webhookUrl={worker.webhook_url}
          />

          <ExecModePicker value={execMode} onChange={setExecMode} />
        </div>

        {/* Right column: file editor */}
        <FilesEditor
          mode="edit"
          files={files}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
          onSelectedPathChange={setSelectedPath}
          onChange={setFiles}
        />
      </div>
    </div>
  );
}
