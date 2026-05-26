"use client";

import { Suspense, use, useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { openOAuthPopup } from "@/lib/oauth-popup";
import { getSupportedApp } from "@/components/connections/connection-data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowLeft, Plus, Trash2, Sparkles, ChevronRight, RotateCcw, CheckCircle2, Loader2, Upload } from "lucide-react";
import type { ComposioTriggerItem, DraftFromPromptResponse, DraftRequirementItem } from "@/lib/types";
import { CronBuilder } from "@/components/CronBuilder";
import { ConnectionEventPicker } from "@/components/ConnectionEventPicker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InputRow {
  name: string;
  label: string;
  type: string;
  required: boolean;
  placeholder: string;
  description: string;
  options: string;
}

interface OutputRow {
  name: string;
  label: string;
  type: string;
}

const INPUT_TYPES = ["text", "textarea", "number", "select", "file", "boolean"] as const;
const OUTPUT_TYPES = ["markdown", "text", "json", "csv", "file"] as const;
type TriggerType = "manual" | "schedule" | "webhook" | "composio";
type PageMode = "prompt" | "form";

// ---------------------------------------------------------------------------
// Prompt examples
// ---------------------------------------------------------------------------

const PROMPT_EXAMPLES = [
  "Summarise all my meetings from Granola and update HubSpot with action items daily",
  "Every morning at 9am, send me a digest of my unread GitHub PRs and open issues",
  "Process any new email in label 'invoices', extract total amount, and add a row to Google Sheets",
  "When a new deal is created in HubSpot, send a Slack message to #sales-channel",
  "Fetch last week's Granola meeting notes and draft follow-up emails via Gmail",
];

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlBlock(value: string, indent = ""): string[] {
  return value.split("\n").map((line) => `${indent}${line}`);
}

/** Build just the trigger YAML block from chosen values. */
function buildTriggerBlock(
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

/** Replace or append the trigger block in a full YAML string. */
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

function sampleValueForInput(input: InputRow): string | number | boolean | null {
  if (input.type === "number") return 1;
  if (input.type === "boolean") return true;
  if (input.type === "file") return null;
  if (input.type === "select") {
    return input.options.split(",").map((option) => option.trim()).filter(Boolean)[0] || "option";
  }
  if (input.type === "textarea") return `Sample ${input.label || input.name} with enough detail for a realistic run.`;
  return `Sample ${input.label || input.name}`;
}

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  return typeof value === "string" ? yamlString(value) : String(value);
}

const TEMPLATES: Record<string, {
  workerId: string;
  name: string;
  description: string;
  inputs: InputRow[];
  outputs: OutputRow[];
  secrets: string;
}> = {
  research_brief: {
    workerId: "research-brief",
    name: "Research Brief",
    description: "Generates a markdown research brief on any topic.",
    inputs: [
      { name: "topic", label: "Research topic", type: "text", required: true, placeholder: "AI recruiting workflow tools in DACH", description: "Topic or question to investigate.", options: "" },
      { name: "audience", label: "Audience", type: "select", required: true, placeholder: "", description: "Reader profile for tone and depth.", options: "executive, technical, sales" },
      { name: "depth", label: "Depth", type: "select", required: true, placeholder: "", description: "Level of detail to produce.", options: "overview, detailed, deep_dive" },
    ],
    outputs: [{ name: "brief", label: "Research brief", type: "markdown" }],
    secrets: "OPENAI_API_KEY",
  },
  gmail_intake_brief: {
    workerId: "gmail-intake-brief",
    name: "Gmail Intake Brief",
    description: "Fetches recent Gmail messages matching a query and returns a markdown summary.",
    inputs: [
      { name: "query", label: "Gmail search query", type: "text", required: false, placeholder: "is:unread label:intake newer_than:7d", description: "Gmail search syntax.", options: "" },
      { name: "max_results", label: "Max emails to fetch", type: "number", required: false, placeholder: "5", description: "Maximum number of matching messages.", options: "" },
    ],
    outputs: [{ name: "summary", label: "Email summary", type: "markdown" }],
    secrets: "OPENAI_API_KEY",
  },
  csv_enricher: {
    workerId: "csv-enricher",
    name: "CSV Enricher",
    description: "Enriches CSV rows using a custom instruction.",
    inputs: [
      { name: "csv_text", label: "CSV rows", type: "textarea", required: true, placeholder: "name,company\\nAlice,Acme", description: "CSV content with headers.", options: "" },
      { name: "instruction", label: "Enrichment instruction", type: "text", required: true, placeholder: "Add ICP fit and reason columns.", description: "How each row needs to be enriched.", options: "" },
    ],
    outputs: [{ name: "enriched_csv", label: "Enriched CSV", type: "csv" }],
    secrets: "OPENAI_API_KEY",
  },
};

const DEFAULT_RUN_PY = `from typing import Dict, Any

def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    context["log"]("Run started")

    # Access inputs like: inputs["my_field"]
    # Access secrets like: context["secrets"]["OPENAI_API_KEY"]

    context["log"]("Processing")

    return {
        "status": "success",
        "outputs": {
            "result": "Hello from worker!"
        },
        "artifacts": []
    }
`;

// ---------------------------------------------------------------------------
// Exec mode type + helpers
// ---------------------------------------------------------------------------

type ExecMode = "agent" | "pure-script" | "hybrid";

function buildExecBlock(mode: ExecMode): string {
  if (mode === "agent") {
    return `exec:
  runtime: skill
  mode: agent
  runner: e2b
  entrypoint: SKILL.md
  inputs: []
  outputs: []`;
  }
  if (mode === "pure-script") {
    return `exec:
  command: python run.py
  runtime: python311
  mode: pure-script
  runner: e2b
  inputs: []
  outputs: []`;
  }
  // hybrid
  return `exec:
  command: python run.py
  runtime: python311
  mode: hybrid
  runner: e2b
  entrypoint: run.py
  inputs: []
  outputs: []`;
}

/** Replace or append the exec block in a full YAML string. */
function replaceExecBlock(yaml: string, execYaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^exec:\s*$/.test(line));
  if (start === -1) return `${yaml.trimEnd()}\n\n${execYaml}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_][\w_-]*:\s*/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...execYaml.split("\n"), ...lines.slice(end)].join("\n");
}

// ---------------------------------------------------------------------------
// Stub YAML for SKILL.md upload path (user will edit before creating)
// ---------------------------------------------------------------------------

function buildStubYaml(slug: string, title: string, mode: ExecMode = "agent"): string {
  const execBlock = buildExecBlock(mode);
  const entrypointLine = mode === "agent" ? "entrypoint: SKILL.md" : "entrypoint: run.py";
  return `schema_version: "0.3"
name: ${slug}
title: ${JSON.stringify(title)}
description: "Describe what this worker does."
version: "0.1.0"
${entrypointLine}
targets: [generic]

${execBlock}

trigger:
  type: manual
`;
}

// ---------------------------------------------------------------------------
// YAML generator
// ---------------------------------------------------------------------------

function buildYaml(
  workerId: string,
  name: string,
  description: string,
  inputs: InputRow[],
  outputs: OutputRow[],
  secrets: string,
  triggerType: TriggerType,
  cronExpr: string,
  cronTimezone: string,
  composioEvent: string,
  composioConnectionId: string,
  composioFilters: string,
): string {
  const slug = (workerId || "my-worker").replace(/_/g, "-");
  const title = name || "My Worker";
  const secretNames = secrets
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const lines: string[] = [];
  lines.push(`schema_version: "0.3"`);
  lines.push(`name: ${slug}`);
  lines.push(`title: ${yamlString(title)}`);
  lines.push(`description: ${yamlString(description || "Custom Workeros worker.")}`);
  lines.push(`long_description: |`);
  lines.push(...yamlBlock(`  Explain what ${title} does, when to run it, and what a trustworthy result looks like.`));
  lines.push(`use_cases:`);
  lines.push(`- Replace this with a concrete operator workflow.`);
  lines.push(`- Replace this with a second realistic use case.`);
  lines.push(`- Replace this with a third realistic use case.`);
  if (inputs.length > 0) {
    lines.push(`example_input:`);
    for (const inp of inputs) {
      if (!inp.name) continue;
      const sample = sampleValueForInput(inp);
      if (typeof sample === "string" && sample.includes("\n")) {
        lines.push(`  ${inp.name}: |`);
        lines.push(...yamlBlock(sample, "    "));
      } else {
        lines.push(`  ${inp.name}: ${yamlScalar(sample)}`);
      }
    }
  } else {
    lines.push(`example_input: {}`);
  }
  lines.push(`example_output: |`);
  lines.push(...yamlBlock(`  ## Example output\n\n  Replace this markdown with the worker's expected result shape.`));
  lines.push(`how_it_works: |`);
  lines.push(...yamlBlock(`  Input\n    -> validate fields\n    -> run worker logic\n    -> return structured output`));
  lines.push(`folder: ${yamlString("Custom")}`);
  lines.push(`tags: ["custom", "template"]`);
  lines.push(`version: "0.1.0"`);
  lines.push(`entrypoint: SKILL.md`);
  lines.push(`targets: [generic]`);
  lines.push(``);
  lines.push(`exec:`);
  lines.push(`  command: python run.py`);
  lines.push(`  runtime: python311`);
  lines.push(`  runner: local`);

  if (inputs.length > 0) {
    lines.push(`  inputs:`);
    for (const inp of inputs) {
      if (!inp.name) continue;
      const isFile = inp.type === "file";
      const scalarType = inp.type === "text" || inp.type === "textarea" ? "string" : inp.type;
      lines.push(`  - name: ${inp.name}`);
      lines.push(`    kind: ${isFile ? "file" : "scalar"}`);
      if (isFile) {
        lines.push(`    media_type: application/octet-stream`);
        lines.push(`    path: inputs/${inp.name}`);
      } else {
        lines.push(`    type: ${scalarType}`);
      }
      lines.push(`    required: ${inp.required}`);
      lines.push(`    label: ${yamlString(inp.label || inp.name)}`);
      if (inp.placeholder) lines.push(`    placeholder: ${yamlString(inp.placeholder)}`);
      if (inp.description) lines.push(`    description: ${yamlString(inp.description)}`);
      if (inp.type === "select") {
        const options = inp.options.split(",").map((o) => o.trim()).filter(Boolean);
        if (options.length > 0) {
          lines.push(`    enum: [${options.map(yamlString).join(", ")}]`);
          lines.push(`    options: [${options.map(yamlString).join(", ")}]`);
        }
      }
    }
  } else {
    lines.push(`  inputs: []`);
  }

  lines.push(`  secrets: [${secretNames.join(", ")}]`);

  if (outputs.length > 0) {
    lines.push(`  outputs:`);
    for (const out of outputs) {
      if (!out.name) continue;
      lines.push(`  - name: ${out.name}`);
      if (out.type === "text") {
        lines.push(`    kind: scalar`);
        lines.push(`    type: string`);
      } else {
        const mediaType = out.type === "markdown"
          ? "text/markdown"
          : out.type === "csv"
          ? "text/csv"
          : out.type === "json"
          ? "application/json"
          : "application/octet-stream";
        const extension = out.type === "markdown" ? "md" : out.type === "file" ? "bin" : out.type;
        lines.push(`    kind: file`);
        lines.push(`    media_type: ${mediaType}`);
        lines.push(`    path: out/${out.name}.${extension}`);
      }
      lines.push(`    required: true`);
      lines.push(`    label: ${yamlString(out.label || out.name)}`);
    }
  } else {
    lines.push(`  outputs: []`);
  }

  lines.push(``);
  lines.push(`capabilities:`);
  lines.push(`  secrets: [${secretNames.join(", ")}]`);
  lines.push(`  network: { egress: ${secretNames.length > 0} }`);
  lines.push(``);
  lines.push(`trigger:`);
  lines.push(`  type: ${triggerType}`);
  if (triggerType === "schedule") {
    lines.push(`  cron: ${yamlString(cronExpr || "0 9 * * MON")}`);
    lines.push(`  timezone: ${yamlString(cronTimezone || "Europe/Berlin")}`);
  }
  if (triggerType === "webhook") {
    lines.push(`  webhook:`);
    lines.push(`    secret: true`);
    lines.push(`    allowed_methods: [POST]`);
  }
  if (triggerType === "composio") {
    let filters: Record<string, unknown> = {};
    try {
      filters = composioFilters.trim() ? JSON.parse(composioFilters) : {};
    } catch {
      filters = {};
    }
    lines.push(`  composio:`);
    lines.push(`    event: ${yamlString(composioEvent)}`);
    lines.push(`    connection_id: ${yamlString(composioConnectionId)}`);
    lines.push(`    filters: ${JSON.stringify(filters)}`);
  }

  return lines.join("\n");
}

function triggerEventId(item: ComposioTriggerItem): string {
  return item.event || item.slug || item.id || item.name || "";
}

function triggerLabel(item: ComposioTriggerItem): string {
  return item.display_name || item.name || triggerEventId(item);
}

function triggerAppSlug(item?: ComposioTriggerItem): string {
  if (!item) return "";
  return (
    item.toolkit?.slug ||
    item.app?.slug ||
    (item as unknown as { toolkit_slug?: string }).toolkit_slug ||
    (item as unknown as { app_name?: string }).app_name ||
    ""
  ).toLowerCase();
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function NewWorkerPage({
  searchParams,
}: {
  searchParams?: Promise<{ template?: string }>;
}) {
  return (
    <Suspense fallback={<NewWorkerSkeleton />}>
      <NewWorkerPageInner searchParams={searchParams} />
    </Suspense>
  );
}

function NewWorkerPageInner({
  searchParams,
}: {
  searchParams?: Promise<{ template?: string }>;
}) {
  const resolvedSearchParams = use(searchParams || Promise.resolve({} as { template?: string }));
  return <NewWorkerContent templateId={resolvedSearchParams.template} />;
}

function NewWorkerSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-8 w-48 bg-[#e4e4e7] rounded-md" />
        <div className="h-4 w-72 bg-[#ececef] rounded-md mt-2" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-[420px] bg-white border border-[#eaeaea] rounded-md" />
        <div className="h-[420px] bg-white border border-[#eaeaea] rounded-md" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PromptStep — Step 1
// Order: prompt + generate -> upload area -> examples
// ---------------------------------------------------------------------------

type UploadState = "idle" | "processing" | "navigating";

function PromptStep({
  onDraft,
  onSkillMdUpload,
  onRunPyUpload,
  onBundleNavigate,
}: {
  onDraft: (draft: DraftFromPromptResponse, prompt: string) => void;
  onSkillMdUpload: (skillMd: string, fileName: string) => void;
  onRunPyUpload: (runPy: string, fileName: string) => void;
  onBundleNavigate: (workerId: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleGenerate() {
    const trimmed = prompt.trim();
    if (!trimmed) {
      toast.error("Describe what you want the worker to do");
      return;
    }
    setGenerating(true);
    try {
      const draft = await api.workers.draftFromPrompt(trimmed);
      onDraft(draft, trimmed);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to generate worker draft");
    } finally {
      setGenerating(false);
    }
  }

  async function handleFiles(files: FileList | File[]) {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;

    // Folder upload: multiple files — zip them and POST to /workers/from-bundle
    if (fileArr.length > 1) {
      await handleFolderOrMultipleFiles(fileArr);
      return;
    }

    const file = fileArr[0];

    if (file.name.endsWith(".zip")) {
      await handleZipUpload(file);
      return;
    }

    if (file.name.endsWith(".py")) {
      const text = await readFileAsText(file);
      if (text !== null) onRunPyUpload(text, file.name);
      return;
    }

    if (file.name.endsWith(".md") || file.name.endsWith(".txt")) {
      const text = await readFileAsText(file);
      if (text !== null) onSkillMdUpload(text, file.name);
      return;
    }

    toast.error("Upload a .md, .py, or .zip file, or drag a folder");
  }

  function readFileAsText(file: File): Promise<string | null> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result;
        if (typeof text === "string" && text.trim()) {
          resolve(text);
        } else {
          toast.error("The file appears to be empty");
          resolve(null);
        }
      };
      reader.onerror = () => { toast.error("Failed to read file"); resolve(null); };
      reader.readAsText(file);
    });
  }

  async function handleZipUpload(file: File) {
    setUploadState("processing");
    try {
      const worker = await api.workers.createFromBundle(file);
      toast.success(`Worker "${worker.name}" created from bundle`);
      setUploadState("navigating");
      onBundleNavigate(worker.id);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create worker from bundle");
      setUploadState("idle");
    }
  }

  async function handleFolderOrMultipleFiles(files: File[]) {
    setUploadState("processing");
    try {
      // Dynamic import to keep bundle split
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      for (const file of files) {
        // file.webkitRelativePath is e.g. "my-worker/worker.yml" when from webkitdirectory
        const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const bytes = await file.arrayBuffer();
        zip.file(path, bytes);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const worker = await api.workers.createFromBundle(blob);
      toast.success(`Worker "${worker.name}" created from folder`);
      setUploadState("navigating");
      onBundleNavigate(worker.id);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create worker from folder");
      setUploadState("idle");
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      // Check if any item is a directory via DataTransferItem
      const firstEntry = items[0].webkitGetAsEntry?.();
      if (firstEntry?.isDirectory) {
        // Can't read directory contents without File System Access API in drop events
        // Fall back to showing a helpful message
        toast.error("Drag-and-drop folders are not supported in all browsers. Use the folder browse button instead.");
        return;
      }
    }
    const files = e.dataTransfer.files;
    if (files.length > 0) void handleFiles(files);
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) {
      void handleFiles(files);
    }
    // Reset so the same file can be re-selected
    e.target.value = "";
  }

  const isUploading = uploadState !== "idle";

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* 1. Prompt box */}
      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardHeader>
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#666]" />
            Describe what you want this worker to do
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            placeholder="e.g. Summarise all my meetings from Granola and update HubSpot with action items daily"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="min-h-[140px] border-[#e4e4e7] text-sm resize-none"
            disabled={generating}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void handleGenerate();
              }
            }}
          />
          <Button
            onClick={() => void handleGenerate()}
            disabled={generating || !prompt.trim()}
            className="w-full"
          >
            {generating ? (
              <span className="flex items-center gap-2">
                <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Generating worker...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                Generate
                <ChevronRight className="w-4 h-4" />
              </span>
            )}
          </Button>
          <p className="text-xs text-[#999] text-center">
            Press Cmd+Enter to generate
          </p>
        </CardContent>
      </Card>

      {/* 2. Upload area: .md / .py / .zip / folder */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-[#666] uppercase tracking-wide">Or upload an existing worker file</p>
        <div
          role="button"
          tabIndex={0}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !isUploading && fileInputRef.current?.click()}
          onKeyDown={(e) => { if (!isUploading && (e.key === "Enter" || e.key === " ")) fileInputRef.current?.click(); }}
          className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-md px-4 py-8 transition-colors ${
            isUploading
              ? "border-[#e4e4e7] bg-[#fafafa] cursor-not-allowed"
              : dragOver
              ? "border-black bg-[#f4f4f5] cursor-pointer"
              : "border-[#e4e4e7] bg-white hover:border-[#ccc] hover:bg-[#fafafa] cursor-pointer"
          }`}
        >
          {isUploading ? (
            <>
              <span className="w-5 h-5 border-2 border-[#666] border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-[#666]">
                {uploadState === "navigating" ? "Navigating to worker..." : "Processing bundle..."}
              </span>
            </>
          ) : (
            <>
              <Upload className="w-5 h-5 text-[#999]" />
              <span className="text-sm text-[#444] font-medium">Drop a file here, or click to browse</span>
              <span className="text-xs text-[#999]">
                .md (SKILL.md), .py (Python script), .zip (full bundle), or a folder
              </span>
              <span className="text-xs text-[#bbb]">
                .md and .py files take you to Step 2 to fill in metadata. Zip or folder bundles are created directly.
              </span>
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.txt,.py,.zip"
          // webkitdirectory is not in standard TS types; cast via spread
          {...({ webkitdirectory: undefined } as React.InputHTMLAttributes<HTMLInputElement>)}
          className="hidden"
          onChange={handleFileInputChange}
          multiple
        />
        {/* Separate folder-browse button for browsers that support webkitdirectory */}
        <button
          type="button"
          disabled={isUploading}
          onClick={() => {
            // Create a temporary input with webkitdirectory for folder picking
            const input = document.createElement("input");
            input.type = "file";
            (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
            input.multiple = true;
            input.onchange = () => {
              if (input.files && input.files.length > 0) void handleFiles(input.files);
            };
            input.click();
          }}
          className="text-xs text-[#999] hover:text-[#555] transition-colors underline"
        >
          Browse a folder instead
        </button>
      </div>

      {/* 3. Examples */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-[#666] uppercase tracking-wide">Examples</p>
        <div className="space-y-2">
          {PROMPT_EXAMPLES.map((example, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPrompt(example)}
              className="w-full text-left text-sm text-[#444] bg-white border border-[#eaeaea] rounded-md px-3 py-2.5 hover:border-[#ccc] hover:bg-[#fafafa] transition-colors"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineSecretRow — inline secret entry card
// ---------------------------------------------------------------------------

interface InlineSecretRowProps {
  name: string;
  initialStatus: "set" | "missing" | "unknown";
  onSaved: (name: string) => void;
}

function InlineSecretRow({ name, initialStatus, onSaved }: InlineSecretRowProps) {
  const [status, setStatus] = useState<"set" | "missing" | "unknown" | "saving">(initialStatus);
  const [value, setValue] = useState("");
  const [showInput, setShowInput] = useState(initialStatus !== "set");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input when shown
  useEffect(() => {
    if (showInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showInput]);

  async function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error(`Enter a value for ${name}`);
      return;
    }
    setStatus("saving");
    try {
      await api.secrets.upsert(name, trimmed);
      setStatus("set");
      setShowInput(false);
      setValue("");
      onSaved(name);
      toast.success(`${name} saved`);
    } catch (e: unknown) {
      setStatus("missing");
      toast.error(e instanceof Error ? e.message : `Failed to save ${name}`);
    }
  }

  if (status === "set") {
    return (
      <div className="flex items-center justify-between py-2 px-3 rounded-md border border-[#e4e4e7] bg-[#f0fdf4]">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-[#16a34a] flex-shrink-0" />
          <span className="text-sm font-mono font-medium text-[#15803d]">{name}</span>
          <span className="text-xs text-[#16a34a]">Set</span>
        </div>
        <button
          type="button"
          onClick={() => { setStatus("missing"); setShowInput(true); }}
          className="text-xs text-[#999] hover:text-[#666] transition-colors"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[#e4e4e7] bg-white p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono font-medium text-[#333]">{name}</span>
        <span className="text-xs text-[#e67e22] bg-[#fef3c7] px-1.5 py-0.5 rounded border border-[#fde68a]">required</span>
      </div>
      {showInput && (
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            type="password"
            placeholder={`Enter ${name}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="border-[#e4e4e7] font-mono text-sm flex-1"
            disabled={status === "saving"}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
            }}
          />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={status === "saving" || !value.trim()}
            className="shrink-0"
          >
            {status === "saving" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              "Save"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineConnectionRow — inline OAuth connection card
// ---------------------------------------------------------------------------

interface InlineConnectionRowProps {
  appSlug: string;
  initialConnected: boolean;
  onConnected: (slug: string) => void;
}

function InlineConnectionRow({ appSlug, initialConnected, onConnected }: InlineConnectionRowProps) {
  const [status, setStatus] = useState<"connected" | "disconnected" | "connecting">(
    initialConnected ? "connected" : "disconnected"
  );
  const app = getSupportedApp(appSlug);

  async function handleConnect() {
    setStatus("connecting");
    try {
      const result = await api.connections.initiate(appSlug);
      if (!result.redirect_url) {
        toast.error(`No OAuth URL returned for ${app.displayName}`);
        setStatus("disconnected");
        return;
      }
      const outcome = await openOAuthPopup({
        oauthUrl: result.redirect_url,
        appSlug,
        onConnected: () => {
          setStatus("connected");
          onConnected(appSlug);
          toast.success(`${app.displayName} connected`);
        },
      });
      if (outcome === "timeout") {
        toast.error(`Connection timed out. Complete the OAuth flow and retry.`);
        setStatus("disconnected");
      } else if (outcome === "closed") {
        // Popup was closed without completing — check if it got connected anyway
        const connections = await api.connections.list();
        const active = connections.find(
          (c) => c.app_name.toLowerCase() === appSlug.toLowerCase() && c.status === "active"
        );
        if (active) {
          setStatus("connected");
          onConnected(appSlug);
          toast.success(`${app.displayName} connected`);
        } else {
          setStatus("disconnected");
        }
      }
    } catch (e: unknown) {
      setStatus("disconnected");
      toast.error(e instanceof Error ? e.message : `Failed to connect ${app.displayName}`);
    }
  }

  if (status === "connected") {
    return (
      <div className="flex items-center justify-between py-2 px-3 rounded-md border border-[#e4e4e7] bg-[#f0fdf4]">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-[#16a34a] flex-shrink-0" />
          <span className="text-sm font-medium text-[#15803d]">{app.displayName}</span>
          <span className="text-xs text-[#16a34a]">Connected</span>
        </div>
        <button
          type="button"
          onClick={handleConnect}
          className="text-xs text-[#999] hover:text-[#666] transition-colors"
        >
          Reconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-md border border-[#e4e4e7] bg-white">
      <span className="text-sm font-medium text-[#333]">{app.displayName}</span>
      <Button
        size="sm"
        variant="outline"
        onClick={handleConnect}
        disabled={status === "connecting"}
        className="shrink-0 h-7 text-xs"
      >
        {status === "connecting" ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" />
            Connecting...
          </span>
        ) : (
          `Connect ${app.displayName}`
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineRequirementRow: unified row for one integration (OAuth or API key)
// ---------------------------------------------------------------------------

interface InlineRequirementRowProps {
  requirement: DraftRequirementItem;
  secretName?: string;
  initialSecretStatus?: "set" | "missing" | "unknown";
  initialConnected?: boolean;
  onReady: (app: string) => void;
  onMethodChange: (app: string, method: "oauth" | "api_key") => void;
}

function InlineRequirementRow({
  requirement,
  secretName,
  initialSecretStatus = "unknown",
  initialConnected = false,
  onReady,
  onMethodChange,
}: InlineRequirementRowProps) {
  const app = getSupportedApp(requirement.app);
  const isOAuth = requirement.method === "oauth";
  const availMethods = requirement.available_methods ?? [];
  const canToggle = availMethods.length === 2;

  // OAuth state
  const [connStatus, setConnStatus] = useState<"connected" | "disconnected" | "connecting">(
    initialConnected ? "connected" : "disconnected"
  );

  // API key state -- derive secret name from current method
  const effectiveSecretName = requirement.method === "api_key"
    ? (secretName ?? `${requirement.app.toUpperCase().replace(/-/g, "_")}_API_KEY`)
    : undefined;
  const [secretStatus, setSecretStatus] = useState<"set" | "missing" | "unknown" | "saving">(initialSecretStatus);
  const [secretValue, setSecretValue] = useState("");
  const [showSecretInput, setShowSecretInput] = useState(initialSecretStatus !== "set");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showSecretInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showSecretInput]);

  // When method changes, reset ready state for this app so the new method's
  // credential must be verified before the user can proceed.
  const prevMethod = useRef(requirement.method);
  useEffect(() => {
    if (prevMethod.current !== requirement.method) {
      prevMethod.current = requirement.method;
      setConnStatus("disconnected");
      setSecretStatus("unknown");
      setSecretValue("");
      setShowSecretInput(true);
    }
  }, [requirement.method]);

  const isReady = isOAuth ? connStatus === "connected" : secretStatus === "set";

  useEffect(() => {
    if (isReady) onReady(requirement.app);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  async function handleConnect() {
    setConnStatus("connecting");
    try {
      const result = await api.connections.initiate(requirement.app);
      if (!result.redirect_url) {
        toast.error(`No OAuth URL returned for ${app.displayName}`);
        setConnStatus("disconnected");
        return;
      }
      const outcome = await openOAuthPopup({
        oauthUrl: result.redirect_url,
        appSlug: requirement.app,
        onConnected: () => {
          setConnStatus("connected");
          onReady(requirement.app);
          toast.success(`${app.displayName} connected`);
        },
      });
      if (outcome === "timeout") {
        toast.error(`Connection timed out. Complete the OAuth flow and retry.`);
        setConnStatus("disconnected");
      } else if (outcome === "closed") {
        const connections = await api.connections.list();
        const active = connections.find(
          (c) => c.app_name.toLowerCase() === requirement.app.toLowerCase() && c.status === "active"
        );
        if (active) {
          setConnStatus("connected");
          onReady(requirement.app);
          toast.success(`${app.displayName} connected`);
        } else {
          setConnStatus("disconnected");
        }
      }
    } catch (e: unknown) {
      setConnStatus("disconnected");
      toast.error(e instanceof Error ? e.message : `Failed to connect ${app.displayName}`);
    }
  }

  async function handleSaveSecret() {
    const trimmed = secretValue.trim();
    if (!trimmed || !effectiveSecretName) {
      toast.error(`Enter a value for ${effectiveSecretName ?? "the API key"}`);
      return;
    }
    setSecretStatus("saving");
    try {
      await api.secrets.upsert(effectiveSecretName, trimmed);
      setSecretStatus("set");
      setShowSecretInput(false);
      setSecretValue("");
      onReady(requirement.app);
      toast.success(`${effectiveSecretName} saved`);
    } catch (e: unknown) {
      setSecretStatus("missing");
      toast.error(e instanceof Error ? e.message : `Failed to save ${effectiveSecretName}`);
    }
  }

  // Method toggle: two-option segmented control (shown when both methods are available)
  const methodToggle = canToggle ? (
    <div className="flex items-center rounded border border-[#e4e4e7] overflow-hidden text-xs font-mono">
      {(["oauth", "api_key"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onMethodChange(requirement.app, m)}
          className={`px-2 py-0.5 transition-colors ${
            requirement.method === m
              ? m === "oauth"
                ? "bg-[#2563eb] text-white"
                : "bg-[#7c3aed] text-white"
              : "bg-white text-[#666] hover:bg-[#f4f4f5]"
          }`}
        >
          {m === "oauth" ? "OAuth" : "API key"}
        </button>
      ))}
    </div>
  ) : (
    // Single method: informational badge only, no toggle
    <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${
      isOAuth
        ? "text-[#2563eb] bg-[#eff6ff] border-[#bfdbfe]"
        : "text-[#7c3aed] bg-[#f5f3ff] border-[#ddd6fe]"
    }`}>
      {isOAuth ? "OAuth" : "API key"}
    </span>
  );

  // Fully ready
  if (isReady) {
    return (
      <div className="rounded-md border border-[#e4e4e7] bg-[#f0fdf4] p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-[#16a34a] flex-shrink-0" />
            <span className="text-sm font-medium text-[#15803d]">{app.displayName}</span>
            {methodToggle}
          </div>
          {isOAuth ? (
            <button type="button" onClick={handleConnect} className="text-xs text-[#999] hover:text-[#666] transition-colors">
              Reconnect
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { setSecretStatus("missing"); setShowSecretInput(true); }}
              className="text-xs text-[#999] hover:text-[#666] transition-colors"
            >
              Change
            </button>
          )}
        </div>
      </div>
    );
  }

  // Not ready: show connect/input UI
  return (
    <div className="rounded-md border border-[#e4e4e7] bg-white p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[#333]">{app.displayName}</span>
          {methodToggle}
        </div>
        {isOAuth && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleConnect}
            disabled={connStatus === "connecting"}
            className="shrink-0 h-7 text-xs"
          >
            {connStatus === "connecting" ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Connecting...
              </span>
            ) : (
              `Connect ${app.displayName}`
            )}
          </Button>
        )}
      </div>
      {!isOAuth && effectiveSecretName && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-[#555]">{effectiveSecretName}</span>
            <span className="text-xs text-[#e67e22] bg-[#fef3c7] px-1.5 py-0.5 rounded border border-[#fde68a]">required</span>
          </div>
          {showSecretInput && (
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                type="password"
                placeholder={`Enter ${effectiveSecretName}`}
                value={secretValue}
                onChange={(e) => setSecretValue(e.target.value)}
                className="border-[#e4e4e7] font-mono text-sm flex-1"
                disabled={secretStatus === "saving"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveSecret();
                }}
              />
              <Button
                size="sm"
                onClick={handleSaveSecret}
                disabled={secretStatus === "saving" || !secretValue.trim()}
                className="shrink-0"
              >
                {secretStatus === "saving" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineRequirements — secrets + connections inline setup panel
// ---------------------------------------------------------------------------

interface SecretState {
  name: string;
  status: "set" | "missing" | "unknown";
}
interface ConnectionState {
  slug: string;
  connected: boolean;
}

interface InlineRequirementsProps {
  requirements?: DraftRequirementItem[];
  requiredSecrets: string[];
  requiredConnections: string[];
  onAllReady: (ready: boolean) => void;
  onRequirementsChange?: (updated: DraftRequirementItem[]) => void;
  skipped: boolean;
  onSkip: () => void;
}

function InlineRequirements({
  requirements,
  requiredSecrets,
  requiredConnections,
  onAllReady,
  onRequirementsChange,
  skipped,
  onSkip,
}: InlineRequirementsProps) {
  const [loading, setLoading] = useState(true);

  // Mutable local copy of requirements so user can flip methods without re-drafting
  const [localRequirements, setLocalRequirements] = useState<DraftRequirementItem[]>(
    requirements ?? []
  );

  // State for legacy mode (when requirements array is absent)
  const [secretStates, setSecretStates] = useState<SecretState[]>(
    requiredSecrets.map((name) => ({ name, status: "unknown" as const }))
  );
  const [connectionStates, setConnectionStates] = useState<ConnectionState[]>(
    requiredConnections.map((slug) => ({ slug, connected: false }))
  );

  // State for new requirements mode
  const [readyApps, setReadyApps] = useState<Set<string>>(new Set());

  const useNewFormat = Array.isArray(requirements) && requirements.length > 0;

  // On mount, check existing secrets and connections
  useEffect(() => {
    let cancelled = false;
    async function checkStatus() {
      try {
        const allSecrets = useNewFormat
          ? requirements!.filter((r) => r.method === "api_key").map((r) => `${r.app.toUpperCase().replace(/-/g, "_")}_API_KEY`)
          : requiredSecrets;
        const allConnections = useNewFormat
          ? requirements!.filter((r) => r.method === "oauth").map((r) => r.app)
          : requiredConnections;

        const [secretList, connectionList] = await Promise.all([
          allSecrets.length > 0 ? api.secrets.list() : Promise.resolve([]),
          allConnections.length > 0 ? api.connections.list() : Promise.resolve([]),
        ]);

        if (cancelled) return;

        const secretMap = new Map(secretList.map((s) => [s.name, s.status]));
        const activeConnections = new Set(
          connectionList
            .filter((c) => c.status === "active")
            .map((c) => c.app_name.toLowerCase())
        );

        if (useNewFormat) {
          // Pre-mark apps that are already ready
          const preReady = new Set<string>();
          for (const req of requirements!) {
            if (req.method === "oauth" && activeConnections.has(req.app.toLowerCase())) {
              preReady.add(req.app);
            } else if (req.method === "api_key") {
              const secretName = `${req.app.toUpperCase().replace(/-/g, "_")}_API_KEY`;
              if ((secretMap.get(secretName) ?? "missing") === "set") {
                preReady.add(req.app);
              }
            }
          }
          setReadyApps(preReady);
        } else {
          setSecretStates(
            requiredSecrets.map((name) => ({
              name,
              status: (secretMap.get(name) ?? "missing") as "set" | "missing",
            }))
          );
          setConnectionStates(
            requiredConnections.map((slug) => ({
              slug,
              connected: activeConnections.has(slug.toLowerCase()),
            }))
          );
        }
      } catch {
        // API errors: show all as unknown/disconnected so user can still proceed
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void checkStatus();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute readiness
  const allReady = useNewFormat
    ? localRequirements.every((r) => readyApps.has(r.app))
    : secretStates.every((s) => s.status === "set") && connectionStates.every((c) => c.connected);

  useEffect(() => {
    onAllReady(allReady);
  }, [allReady, onAllReady]);

  function handleSecretSaved(name: string) {
    setSecretStates((prev) =>
      prev.map((s) => (s.name === name ? { ...s, status: "set" } : s))
    );
  }

  function handleConnectionConnected(slug: string) {
    setConnectionStates((prev) =>
      prev.map((c) => (c.slug === slug ? { ...c, connected: true } : c))
    );
  }

  function handleRequirementReady(app: string) {
    setReadyApps((prev) => new Set([...prev, app]));
  }

  function handleMethodChange(app: string, method: "oauth" | "api_key") {
    setLocalRequirements((prev) => {
      const updated = prev.map((r) =>
        r.app === app ? { ...r, method } : r
      );
      onRequirementsChange?.(updated);
      return updated;
    });
    // When method flips, this app is no longer ready until new credential verified
    setReadyApps((prev) => {
      const next = new Set(prev);
      next.delete(app);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[#999]">
        <Loader2 className="w-4 h-4 animate-spin" />
        Checking existing secrets and connections...
      </div>
    );
  }

  const hasRequirements = useNewFormat
    ? localRequirements.length > 0
    : requiredSecrets.length > 0 || requiredConnections.length > 0;
  if (!hasRequirements) return null;

  return (
    <Card className="border-[#eaeaea] shadow-none bg-white">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">
            {allReady ? (
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-[#16a34a]" />
                Requirements ready
              </span>
            ) : (
              "Set up requirements"
            )}
          </CardTitle>
          {!allReady && !skipped && (
            <button
              type="button"
              onClick={onSkip}
              className="text-xs text-[#999] hover:text-[#666] transition-colors"
            >
              Skip for now
            </button>
          )}
        </div>
        {!allReady && !skipped && (
          <p className="text-xs text-[#999] mt-0.5">
            Connect the integrations this worker needs before creating it.
          </p>
        )}
        {skipped && (
          <p className="text-xs text-amber-600 mt-0.5">
            Skipped. You can configure these later in Settings / Connections.
          </p>
        )}
      </CardHeader>
      {!skipped && (
        <CardContent className="space-y-2">
          {useNewFormat ? (
            // New unified list: one row per app, no duplicates
            localRequirements.map((req) => {
              const secretName = req.method === "api_key"
                ? `${req.app.toUpperCase().replace(/-/g, "_")}_API_KEY`
                : undefined;
              return (
                <InlineRequirementRow
                  key={req.app}
                  requirement={req}
                  secretName={secretName}
                  initialSecretStatus="unknown"
                  initialConnected={readyApps.has(req.app)}
                  onReady={handleRequirementReady}
                  onMethodChange={handleMethodChange}
                />
              );
            })
          ) : (
            // Legacy two-section layout for backward compatibility
            <>
              {requiredSecrets.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs text-[#666] uppercase tracking-wide">API keys</Label>
                  <div className="space-y-2">
                    {secretStates.map((s) => (
                      <InlineSecretRow
                        key={s.name}
                        name={s.name}
                        initialStatus={s.status}
                        onSaved={handleSecretSaved}
                      />
                    ))}
                  </div>
                </div>
              )}

              {requiredConnections.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs text-[#666] uppercase tracking-wide">OAuth connections</Label>
                  <div className="space-y-2">
                    {connectionStates.map((c) => (
                      <InlineConnectionRow
                        key={c.slug}
                        appSlug={c.slug}
                        initialConnected={c.connected}
                        onConnected={handleConnectionConnected}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ReviewStep — Step 2
// ---------------------------------------------------------------------------

const DRAFT_SESSION_KEY = "workeros:draft-in-progress";

interface DraftSession {
  prompt: string;
  draft: DraftFromPromptResponse;
}

/** Persist draft to sessionStorage so a popup OAuth flow doesn't lose it. */
function persistDraftSession(prompt: string, draft: DraftFromPromptResponse) {
  try {
    sessionStorage.setItem(DRAFT_SESSION_KEY, JSON.stringify({ prompt, draft }));
  } catch {
    // sessionStorage unavailable (private browsing restrictions)
  }
}

/** Load persisted draft from sessionStorage (used on reload after OAuth popup). */
export function loadDraftSession(): DraftSession | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DraftSession;
  } catch {
    return null;
  }
}

function ReviewStep({
  draft,
  originalPrompt,
  initialExecMode,
}: {
  draft: DraftFromPromptResponse;
  originalPrompt: string;
  initialExecMode?: ExecMode;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<"review" | "yaml">("review");

  const [workerYml, setWorkerYml] = useState(draft.worker_yml);
  const [workerId, setWorkerId] = useState(draft.suggested_name);
  const [name, setName] = useState(draft.suggested_title);
  const [triggerType, setTriggerType] = useState<TriggerType>("manual");
  const [cronExpr, setCronExpr] = useState("0 9 * * MON");
  const [cronTimezone, setCronTimezone] = useState("Europe/Berlin");
  const [composioEvent, setComposioEvent] = useState("");
  const [composioConnectionId, setComposioConnectionId] = useState("");
  const [runPy, setRunPy] = useState(DEFAULT_RUN_PY);
  const [execMode, setExecMode] = useState<ExecMode>(initialExecMode ?? "agent");

  // Inline requirements state
  const [requirementsReady, setRequirementsReady] = useState(false);
  const [requirementsSkipped, setRequirementsSkipped] = useState(false);
  // Tracks user-chosen methods (mutable copy of draft.requirements)
  const [chosenRequirements, setChosenRequirements] = useState<DraftRequirementItem[]>(
    draft.requirements ?? []
  );

  const hasRequirements =
    (Array.isArray(draft.requirements) && draft.requirements.length > 0) ||
    draft.required_secrets.length > 0 ||
    draft.required_connections.length > 0;

  // Persist draft session to survive OAuth popup navigations
  useEffect(() => {
    persistDraftSession(originalPrompt, draft);
    return () => {
      // Clear when the component unmounts (worker created or start-over)
      try { sessionStorage.removeItem(DRAFT_SESSION_KEY); } catch { /* ignore */ }
    };
  }, [originalPrompt, draft]);

  const idError =
    workerId && !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(workerId)
      ? "Use lowercase letters, numbers, and hyphens. Start and end with a letter or number."
      : null;

  const canCreate =
    !submitting &&
    !!workerId &&
    !idError &&
    (requirementsReady || requirementsSkipped || !hasRequirements);

  async function handleCreate() {
    if (!workerId) { toast.error("Worker ID is required"); return; }
    if (idError) { toast.error(idError); return; }
    if (triggerType === "composio" && (!composioEvent || !composioConnectionId)) {
      toast.error("Select an integration event and connection");
      return;
    }
    setSubmitting(true);
    try {
      let yamlToUse: string;
      if (activeTab === "yaml") {
        yamlToUse = workerYml;
      } else {
        // Patch trigger block and exec mode block into the draft YAML
        const triggerYaml = buildTriggerBlock(
          triggerType, cronExpr, cronTimezone, composioEvent, composioConnectionId,
        );
        let base = replaceTriggerBlock(draft.worker_yml, triggerYaml);
        base = replaceExecBlock(base, buildExecBlock(execMode));
        // Patch connections list based on user-chosen methods:
        // only apps with method=oauth go into connections; api_key apps are secrets.
        if (chosenRequirements.length > 0) {
          const oauthApps = chosenRequirements.filter((r) => r.method === "oauth").map((r) => r.app);
          const connectionsLine = oauthApps.length > 0
            ? `connections: [${oauthApps.join(", ")}]`
            : "connections: []";
          // Replace existing connections line or append before trigger block
          const hasConn = /^connections:/m.test(base);
          if (hasConn) {
            base = base.replace(/^connections:.*$/m, connectionsLine);
          } else {
            base = `${base.trimEnd()}\n${connectionsLine}\n`;
          }
        }
        yamlToUse = base;
      }
      // For hybrid/pure-script we always pass run_py; for agent it is ignored by the backend
      const skillMdToSend = execMode === "pure-script" ? undefined : draft.skill_md;
      const worker = await api.workers.create(yamlToUse, runPy, skillMdToSend);
      try { sessionStorage.removeItem(DRAFT_SESSION_KEY); } catch { /* ignore */ }
      toast.success(`Worker "${worker.name}" created`);
      router.push(`/workers/${worker.id}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create worker");
    } finally {
      setSubmitting(false);
    }
  }

  const handleRequirementsReady = useCallback((ready: boolean) => {
    setRequirementsReady(ready);
  }, []);

  const displayYaml = activeTab === "yaml" ? workerYml : draft.worker_yml;

  return (
    <div className="space-y-6">
      {/* Source prompt */}
      <div className="rounded-md border border-[#e4e4e7] bg-[#fafafa] px-4 py-3">
        <p className="text-xs text-[#999] mb-1 font-medium uppercase tracking-wide">From prompt</p>
        <p className="text-sm text-[#444]">{originalPrompt}</p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 border border-[#eaeaea] rounded-md p-1 bg-white w-fit">
        {([["review", "Review"], ["yaml", "Advanced: YAML"]] as const).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-xs font-medium rounded-sm transition-colors ${
              activeTab === tab
                ? "bg-black text-white"
                : "text-[#666] hover:bg-[#f4f4f5]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "review" ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <div className="space-y-5">
            {/* Worker mode picker */}
            <Card className="border-[#eaeaea] shadow-none bg-white">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Worker mode</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {([
                  ["agent", "Agent (SKILL.md only)", "The agent reads SKILL.md and uses tools. No Python required."],
                  ["pure-script", "Pure Python (run.py only)", "The Python script runs directly. No SKILL.md needed."],
                  ["hybrid", "Hybrid (run.py + SKILL.md)", "Python controls flow and can invoke an agent helper via SKILL.md."],
                ] as const).map(([value, label, hint]) => (
                  <label
                    key={value}
                    className={`flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-colors ${
                      execMode === value
                        ? "border-black bg-[#f9f9f9]"
                        : "border-[#e4e4e7] hover:border-[#ccc] hover:bg-[#fafafa]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="exec-mode"
                      value={value}
                      checked={execMode === value}
                      onChange={() => setExecMode(value)}
                      className="mt-0.5 accent-black"
                    />
                    <div>
                      <p className="text-sm font-medium text-[#222]">{label}</p>
                      <p className="text-xs text-[#888] mt-0.5">{hint}</p>
                    </div>
                  </label>
                ))}
                {execMode === "hybrid" && (
                  <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                    Hybrid runtime support (exposing SKILL.md to run.py at execution) is planned for a future release. Both files will be written to disk.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Identity */}
            <Card className="border-[#eaeaea] shadow-none bg-white">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Identity</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-sm">
                    Worker ID <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    value={workerId}
                    onChange={(e) => setWorkerId(e.target.value.toLowerCase().replace(/[\s_]+/g, "-"))}
                    className={`border-[#e4e4e7] font-mono ${idError ? "border-red-400" : ""}`}
                  />
                  {idError && <p className="text-xs text-red-500">{idError}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">Name</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="border-[#e4e4e7]"
                  />
                </div>
              </CardContent>
            </Card>

            {/* SKILL.md viewer (read-only): shown when draft has skill_md */}
            {draft.skill_md && (
              <Card className="border-[#eaeaea] shadow-none bg-white">
                <CardHeader>
                  <CardTitle className="text-sm font-medium">SKILL.md (read-only)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="prose prose-sm max-w-none text-[#333] bg-[#fafafa] p-3 rounded-md border border-[#eaeaea] overflow-auto max-h-[300px] text-xs">
                    <pre className="whitespace-pre-wrap font-mono text-xs text-[#444]">{draft.skill_md}</pre>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Inline requirements: one row per integration, no duplicates */}
            {hasRequirements && (
              <InlineRequirements
                requirements={chosenRequirements.length > 0 ? chosenRequirements : draft.requirements}
                requiredSecrets={draft.required_secrets}
                requiredConnections={draft.required_connections}
                onAllReady={handleRequirementsReady}
                onRequirementsChange={setChosenRequirements}
                skipped={requirementsSkipped}
                onSkip={() => setRequirementsSkipped(true)}
              />
            )}

            {/* I/O schema */}
            {draft.inputs.length > 0 && (
              <Card className="border-[#eaeaea] shadow-none bg-white">
                <CardHeader>
                  <CardTitle className="text-sm font-medium">Inputs</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {draft.inputs.map((inp) => (
                      <div key={inp.name} className="flex items-center justify-between py-1.5 border-b border-[#f4f4f5] last:border-0">
                        <div>
                          <span className="text-sm font-medium font-mono">{inp.name}</span>
                          <span className="text-xs text-[#999] ml-2">{inp.label}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-[#666] bg-[#f4f4f5] px-1.5 py-0.5 rounded">{inp.type}</span>
                          {inp.required && (
                            <span className="text-xs text-red-500">required</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {draft.outputs.length > 0 && (
              <Card className="border-[#eaeaea] shadow-none bg-white">
                <CardHeader>
                  <CardTitle className="text-sm font-medium">Outputs</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {draft.outputs.map((out) => (
                      <div key={out.name} className="flex items-center justify-between py-1.5 border-b border-[#f4f4f5] last:border-0">
                        <div>
                          <span className="text-sm font-medium font-mono">{out.name}</span>
                          <span className="text-xs text-[#999] ml-2">{out.label}</span>
                        </div>
                        <span className="text-xs text-[#666] bg-[#f4f4f5] px-1.5 py-0.5 rounded">{out.type}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Trigger override */}
            <Card className="border-[#eaeaea] shadow-none bg-white">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Trigger</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-sm">Type</Label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
                {triggerType === "webhook" && (
                  <div className="rounded-md border border-[#e4e4e7] bg-[#fafafa] p-3 text-sm text-[#555]">
                    Webhook trigger with per-worker HMAC signing enabled.
                  </div>
                )}
                {triggerType === "composio" && (
                  <ConnectionEventPicker
                    composioEvent={composioEvent}
                    composioConnectionId={composioConnectionId}
                    onEventChange={setComposioEvent}
                    onConnectionIdChange={setComposioConnectionId}
                  />
                )}
              </CardContent>
            </Card>

            <div className="space-y-2">
              <Button
                onClick={handleCreate}
                disabled={!canCreate}
                className="w-full"
              >
                {submitting ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Creating worker...
                  </span>
                ) : hasRequirements && !requirementsReady && !requirementsSkipped ? (
                  "Set up requirements to create worker"
                ) : (
                  "Create worker"
                )}
              </Button>
              {hasRequirements && !requirementsReady && !requirementsSkipped && (
                <p className="text-xs text-center text-[#999]">
                  Complete the requirements above, or{" "}
                  <button
                    type="button"
                    onClick={() => setRequirementsSkipped(true)}
                    className="underline hover:text-[#666] transition-colors"
                  >
                    skip for now
                  </button>{" "}
                  to create and configure later.
                </p>
              )}
            </div>
          </div>

          {/* Right: YAML preview */}
          <div className="sticky top-6">
            <Card className="border-[#eaeaea] shadow-none bg-white">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Generated worker.yml</CardTitle>
              </CardHeader>
              <CardContent>
                <YamlPreview yaml={displayYaml} />
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        /* Advanced YAML tab */
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <div className="space-y-5">
            <Card className="border-[#eaeaea] shadow-none bg-white">
              <CardHeader>
                <CardTitle className="text-sm font-medium">worker.yml</CardTitle>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={workerYml}
                  onChange={(e) => setWorkerYml(e.target.value)}
                  className="min-h-[500px] border-[#e4e4e7] font-mono text-xs"
                  spellCheck={false}
                />
              </CardContent>
            </Card>

            <Card className="border-[#eaeaea] shadow-none bg-white">
              <CardHeader>
                <CardTitle className="text-sm font-medium">run.py</CardTitle>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={runPy}
                  onChange={(e) => setRunPy(e.target.value)}
                  className="min-h-[220px] border-[#e4e4e7] font-mono text-xs"
                  spellCheck={false}
                />
              </CardContent>
            </Card>

            <Button
              onClick={handleCreate}
              disabled={!canCreate}
              className="w-full"
            >
              {submitting ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Creating worker...
                </span>
              ) : (
                "Create worker"
              )}
            </Button>
          </div>

          <div className="sticky top-6">
            <Card className="border-[#eaeaea] shadow-none bg-white">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Preview</CardTitle>
              </CardHeader>
              <CardContent>
                <YamlPreview yaml={displayYaml} />
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NewWorkerContent — orchestrates prompt vs form mode
// ---------------------------------------------------------------------------

function NewWorkerContent({ templateId }: { templateId?: string }) {
  const router = useRouter();
  const [pageMode, setPageMode] = useState<PageMode>("prompt");
  const [draft, setDraft] = useState<DraftFromPromptResponse | null>(null);
  const [originalPrompt, setOriginalPrompt] = useState("");
  const [initialExecMode, setInitialExecMode] = useState<ExecMode>("agent");

  const hasTemplate = Boolean(templateId && TEMPLATES[templateId]);

  if (hasTemplate) {
    return <OldFormContent templateId={templateId} />;
  }

  function handleDraft(d: DraftFromPromptResponse, prompt: string) {
    setDraft(d);
    setOriginalPrompt(prompt);
    setInitialExecMode("agent");
    setPageMode("form");
  }

  function handleSkillMdUpload(skillMd: string, fileName: string) {
    const rawSlug = fileName.replace(/\.md$/i, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "") || "my-worker";
    const slug = rawSlug.slice(0, 63);
    const title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    const stubDraft: DraftFromPromptResponse = {
      worker_yml: buildStubYaml(slug, title, "agent"),
      skill_md: skillMd,
      suggested_name: slug,
      suggested_title: title,
      required_connections: [],
      required_secrets: [],
      inputs: [],
      outputs: [],
    };

    setDraft(stubDraft);
    setOriginalPrompt(`Uploaded: ${fileName}`);
    setInitialExecMode("agent");
    setPageMode("form");
  }

  function handleRunPyUpload(runPy: string, fileName: string) {
    const rawSlug = fileName.replace(/\.py$/i, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "") || "my-worker";
    const slug = rawSlug.slice(0, 63);
    const title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    const stubDraft: DraftFromPromptResponse = {
      worker_yml: buildStubYaml(slug, title, "pure-script"),
      skill_md: undefined,
      suggested_name: slug,
      suggested_title: title,
      required_connections: [],
      required_secrets: [],
      inputs: [],
      outputs: [],
    };

    setDraft(stubDraft);
    setOriginalPrompt(`Uploaded: ${fileName}`);
    setInitialExecMode("pure-script");
    setPageMode("form");
  }

  function handleBundleNavigate(workerId: string) {
    router.push(`/workers/${workerId}`);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push("/workers")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">New worker</h1>
          <p className="text-[#666] text-sm">
            {pageMode === "prompt"
              ? "Describe what you want to automate and we will draft the worker for you."
              : "Review the worker, then create it."}
          </p>
        </div>
        {pageMode === "form" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setPageMode("prompt"); setDraft(null); }}
            className="text-[#666] text-xs"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1" />
            Start over
          </Button>
        )}
      </div>

      {pageMode === "prompt" && (
        <PromptStep
          onDraft={handleDraft}
          onSkillMdUpload={handleSkillMdUpload}
          onRunPyUpload={handleRunPyUpload}
          onBundleNavigate={handleBundleNavigate}
        />
      )}

      {pageMode === "form" && draft && (
        <ReviewStep
          draft={draft}
          originalPrompt={originalPrompt}
          initialExecMode={initialExecMode}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OldFormContent — original advanced form (used by template= links)
// ---------------------------------------------------------------------------

function OldFormContent({ templateId }: { templateId?: string }) {
  const router = useRouter();
  const template = templateId ? TEMPLATES[templateId] : undefined;
  const [submitting, setSubmitting] = useState(false);

  const [workerId, setWorkerId] = useState(template?.workerId || "");
  const [name, setName] = useState(template?.name || "");
  const [description, setDescription] = useState(template?.description || "");
  const [inputs, setInputs] = useState<InputRow[]>(template?.inputs || []);
  const [outputs, setOutputs] = useState<OutputRow[]>(template?.outputs || []);
  const [secrets, setSecrets] = useState(template?.secrets || "");
  const [runPy, setRunPy] = useState(DEFAULT_RUN_PY);
  const [triggerType, setTriggerType] = useState<TriggerType>("manual");
  const [cronExpr, setCronExpr] = useState("0 9 * * MON");
  const [cronTimezone, setCronTimezone] = useState("Europe/Berlin");
  const [composioEvent, setComposioEvent] = useState("");
  const [composioConnectionId, setComposioConnectionId] = useState("");

  const idError =
    workerId && !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(workerId)
      ? "Use lowercase letters, numbers, and hyphens. Start and end with a letter or number."
      : null;

  const yaml = buildYaml(
    workerId, name, description, inputs, outputs, secrets,
    triggerType, cronExpr, cronTimezone, composioEvent, composioConnectionId, "{}",
  );

  const addInput = useCallback(() => {
    setInputs((prev) => [
      ...prev,
      { name: "", label: "", type: "text", required: false, placeholder: "", description: "", options: "" },
    ]);
  }, []);

  const updateInput = useCallback((idx: number, field: keyof InputRow, value: string | boolean | null) => {
    if (value === null) return;
    setInputs((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, [field]: value } : row))
    );
  }, []);

  const removeInput = useCallback((idx: number) => {
    setInputs((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const addOutput = useCallback(() => {
    setOutputs((prev) => [...prev, { name: "", label: "", type: "markdown" }]);
  }, []);

  const updateOutput = useCallback((idx: number, field: keyof OutputRow, value: string | null) => {
    if (value === null) return;
    setOutputs((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, [field]: value } : row))
    );
  }, []);

  const removeOutput = useCallback((idx: number) => {
    setOutputs((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  async function handleSubmit() {
    if (!workerId) { toast.error("Worker ID is required"); return; }
    if (idError) { toast.error(idError); return; }
    if (!name) { toast.error("Name is required"); return; }
    if (inputs.some((inp) => inp.type === "select" && !inp.options.split(",").some((o) => o.trim()))) {
      toast.error("Select inputs need at least one option");
      return;
    }
    if (triggerType === "schedule" && !cronExpr.trim()) {
      toast.error("Cron expression is required");
      return;
    }
    if (triggerType === "composio") {
      if (!composioEvent) { toast.error("Select an integration event"); return; }
      if (!composioConnectionId) { toast.error("Select a connected account"); return; }
    }

    setSubmitting(true);
    try {
      const worker = await api.workers.create(yaml, runPy);
      toast.success(`Worker "${worker.name}" created`);
      router.push(`/workers/${worker.id}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create worker");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push("/workers")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">New worker</h1>
          <p className="text-[#666] text-sm">Define your worker and its interface.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <div className="space-y-5">
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader><CardTitle className="text-sm font-medium">Identity</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-sm">Worker ID <span className="text-red-500">*</span></Label>
                <Input
                  placeholder="my-worker"
                  value={workerId}
                  onChange={(e) => setWorkerId(e.target.value.toLowerCase().replace(/[\s_]+/g, "-"))}
                  className={`border-[#e4e4e7] font-mono ${idError ? "border-red-400" : ""}`}
                />
                {idError && <p className="text-xs text-red-500">{idError}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Name <span className="text-red-500">*</span></Label>
                <Input placeholder="My Worker" value={name} onChange={(e) => setName(e.target.value)} className="border-[#e4e4e7]" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Description</Label>
                <Textarea placeholder="What does this worker do?" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-[60px] border-[#e4e4e7]" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader><CardTitle className="text-sm font-medium">Trigger</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-sm">Type</Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {([["manual", "Manual"], ["schedule", "Cron"], ["webhook", "Webhook"], ["composio", "Connection event"]] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setTriggerType(value)}
                      className={`h-8 rounded-md border px-2 text-xs font-medium whitespace-nowrap transition-colors ${triggerType === value ? "border-black bg-black text-white" : "border-[#e4e4e7] bg-white text-[#333] hover:bg-[#f4f4f5]"}`}
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
              {triggerType === "webhook" && (
                <div className="rounded-md border border-[#e4e4e7] bg-[#fafafa] p-3 text-sm text-[#555]">
                  Webhook trigger with per-worker HMAC signing enabled.
                </div>
              )}
              {triggerType === "composio" && (
                <ConnectionEventPicker
                  composioEvent={composioEvent}
                  composioConnectionId={composioConnectionId}
                  onEventChange={setComposioEvent}
                  onConnectionIdChange={setComposioConnectionId}
                />
              )}
            </CardContent>
          </Card>

          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Inputs</CardTitle>
                <Button variant="ghost" size="sm" onClick={addInput} className="h-7 px-2 text-xs">
                  <Plus className="w-3.5 h-3.5 mr-1" />Add input
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {inputs.length === 0 && <p className="text-sm text-[#999]">No inputs yet.</p>}
              {inputs.map((inp, idx) => (
                <div key={idx} className="space-y-2 p-3 bg-[#f9f9f9] rounded-md">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-[#666]">Input {idx + 1}</span>
                    <Button variant="ghost" size="sm" onClick={() => removeInput(idx)} className="h-6 w-6 p-0 text-[#999] hover:text-red-500">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Name</Label>
                      <Input placeholder="my_field" value={inp.name} onChange={(e) => updateInput(idx, "name", e.target.value)} className="h-7 text-xs border-[#e4e4e7] font-mono" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Label</Label>
                      <Input placeholder="My Field" value={inp.label} onChange={(e) => updateInput(idx, "label", e.target.value)} className="h-7 text-xs border-[#e4e4e7]" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Type</Label>
                      <Select value={inp.type} onValueChange={(v) => updateInput(idx, "type", v)}>
                        <SelectTrigger className="h-7 text-xs border-[#e4e4e7]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {INPUT_TYPES.map((t) => <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Placeholder</Label>
                      <Input value={inp.placeholder} onChange={(e) => updateInput(idx, "placeholder", e.target.value)} className="h-7 text-xs border-[#e4e4e7]" />
                    </div>
                  </div>
                  {inp.type === "select" && (
                    <div className="space-y-1">
                      <Label className="text-xs">Options</Label>
                      <Input placeholder="alpha, beta, gamma" value={inp.options} onChange={(e) => updateInput(idx, "options", e.target.value)} className="h-7 text-xs border-[#e4e4e7]" />
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id={`inp-req-${idx}`} checked={inp.required} onChange={(e) => updateInput(idx, "required", e.target.checked)} className="w-3.5 h-3.5 rounded border-[#e4e4e7] accent-black cursor-pointer" />
                    <label htmlFor={`inp-req-${idx}`} className="text-xs text-[#666] cursor-pointer">Required</label>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Outputs</CardTitle>
                <Button variant="ghost" size="sm" onClick={addOutput} className="h-7 px-2 text-xs">
                  <Plus className="w-3.5 h-3.5 mr-1" />Add output
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {outputs.length === 0 && <p className="text-sm text-[#999]">No outputs yet.</p>}
              {outputs.map((out, idx) => (
                <div key={idx} className="space-y-2 p-3 bg-[#f9f9f9] rounded-md">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-[#666]">Output {idx + 1}</span>
                    <Button variant="ghost" size="sm" onClick={() => removeOutput(idx)} className="h-6 w-6 p-0 text-[#999] hover:text-red-500">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Name</Label>
                      <Input placeholder="result" value={out.name} onChange={(e) => updateOutput(idx, "name", e.target.value)} className="h-7 text-xs border-[#e4e4e7] font-mono" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Label</Label>
                      <Input placeholder="Result" value={out.label} onChange={(e) => updateOutput(idx, "label", e.target.value)} className="h-7 text-xs border-[#e4e4e7]" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Type</Label>
                    <Select value={out.type} onValueChange={(v) => updateOutput(idx, "type", v)}>
                      <SelectTrigger className="h-7 text-xs border-[#e4e4e7]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {OUTPUT_TYPES.map((t) => <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader><CardTitle className="text-sm font-medium">Secrets</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-sm">Secrets</Label>
                <Input placeholder="OPENAI_API_KEY, APOLLO_API_KEY" value={secrets} onChange={(e) => setSecrets(e.target.value)} className="border-[#e4e4e7] font-mono text-sm" />
                <p className="text-xs text-[#999]">Comma-separated env var names this worker needs.</p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader><CardTitle className="text-sm font-medium">run.py</CardTitle></CardHeader>
            <CardContent>
              <Textarea value={runPy} onChange={(e) => setRunPy(e.target.value)} className="min-h-[220px] border-[#e4e4e7] font-mono text-xs" spellCheck={false} />
            </CardContent>
          </Card>

          <Button onClick={handleSubmit} disabled={submitting || !workerId || !name || !!idError} className="w-full">
            {submitting ? "Creating..." : "Create worker"}
          </Button>
        </div>

        <div className="sticky top-6">
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader><CardTitle className="text-sm font-medium">worker.yml preview</CardTitle></CardHeader>
            <CardContent>
              <YamlPreview yaml={yaml} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// YAML Syntax Highlighter (hand-rolled, no external dep)
// ---------------------------------------------------------------------------

function YamlPreview({ yaml }: { yaml: string }) {
  const lines = yaml.split("\n");
  return (
    <pre className="text-xs leading-relaxed overflow-auto max-h-[600px] font-mono">
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
