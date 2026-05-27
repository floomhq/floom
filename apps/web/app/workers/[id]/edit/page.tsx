"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { load as parseYaml } from "js-yaml";
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
import type { DetectedEntry, TriggerRow } from "@/components/worker-form";

// ---------------------------------------------------------------------------
// PR S13 hotfix: parse exec.entry from worker.yml; file-list heuristic only as legacy fallback.
// ---------------------------------------------------------------------------

function detectEntry(files: { path: string; content: string }[]): {
  entry: DetectedEntry;
  legacyFallback: boolean;
} {
  const workerYml = files.find((f) => f.path === "worker.yml")?.content ?? "";
  if (workerYml.trim()) {
    try {
      const parsed = parseYaml(workerYml) as { exec?: { entry?: unknown } } | null;
      const entryValue = parsed?.exec?.entry;
      if (typeof entryValue === "string" && entryValue.trim()) {
        const normalized = entryValue.trim().toLowerCase();
        if (normalized.endsWith(".md")) {
          return { entry: "SKILL.md", legacyFallback: false };
        }
        if (
          normalized.endsWith(".py")
          || normalized.endsWith(".sh")
          || normalized.endsWith(".js")
        ) {
          return { entry: "run.py", legacyFallback: false };
        }
      }
    } catch {
      // Fall through to legacy file-list inference.
    }
  }

  const paths = new Set(files.map((f) => f.path));
  if (paths.has("SKILL.md")) return { entry: "SKILL.md", legacyFallback: true };
  if (paths.has("run.py")) return { entry: "run.py", legacyFallback: true };
  if (files.some((f) => /\.(py|sh|js)$/.test(f.path))) {
    return { entry: "run.py", legacyFallback: true };
  }
  return { entry: "none", legacyFallback: true };
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
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [saving, setSaving] = useState(false);
  const { entry: detectedEntry, legacyFallback } = detectEntry(files);

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

  if (loading || !worker) {
    return <EditSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* S23: edit page header now matches /workers/<id> chrome. Worker name as
          H1 (not "Edit worker"), inline "Editing" pill in Floom blue when
          dirty, no back arrow (sidebar nav covers it). Save replaces the
          "Edit" button slot on the right. */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold tracking-tight">{worker.name}</h1>
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]">
              <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
              Editing
            </span>
            {isDirty && (
              <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900">
                Unsaved changes
              </span>
            )}
          </div>
          {worker.description && (
            <p className="text-muted-foreground text-sm mt-1">{worker.description}</p>
          )}
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

          <ExecModePicker detectedEntry={detectedEntry} />
          {legacyFallback && (
            <p className="text-xs text-amber-700">
              Legacy worker - set <code>exec.entry</code> in worker.yml
            </p>
          )}
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
