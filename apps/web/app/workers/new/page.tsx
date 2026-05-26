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
import { ArrowLeft, Plus, Trash2, Sparkles, ChevronRight, RotateCcw, CheckCircle2, Loader2 } from "lucide-react";
import type { ComposioTriggerItem, ConnectionItem, DraftFromPromptResponse } from "@/lib/types";

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
// ---------------------------------------------------------------------------

function PromptStep({
  onDraft,
}: {
  onDraft: (draft: DraftFromPromptResponse, prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);

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

  return (
    <div className="max-w-2xl mx-auto space-y-6">
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
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                handleGenerate();
              }
            }}
          />
          <Button
            onClick={handleGenerate}
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
  requiredSecrets: string[];
  requiredConnections: string[];
  onAllReady: (ready: boolean) => void;
  skipped: boolean;
  onSkip: () => void;
}

function InlineRequirements({
  requiredSecrets,
  requiredConnections,
  onAllReady,
  skipped,
  onSkip,
}: InlineRequirementsProps) {
  const [secretStates, setSecretStates] = useState<SecretState[]>(
    requiredSecrets.map((name) => ({ name, status: "unknown" as const }))
  );
  const [connectionStates, setConnectionStates] = useState<ConnectionState[]>(
    requiredConnections.map((slug) => ({ slug, connected: false }))
  );
  const [loading, setLoading] = useState(true);

  // On mount, check existing secrets and connections
  useEffect(() => {
    let cancelled = false;
    async function checkStatus() {
      try {
        const [secretList, connectionList] = await Promise.all([
          requiredSecrets.length > 0 ? api.secrets.list() : Promise.resolve([]),
          requiredConnections.length > 0 ? api.connections.list() : Promise.resolve([]),
        ]);

        if (cancelled) return;

        const secretMap = new Map(secretList.map((s) => [s.name, s.status]));
        const activeConnections = new Set(
          connectionList
            .filter((c) => c.status === "active")
            .map((c) => c.app_name.toLowerCase())
        );

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
  const allSecretsSet = secretStates.every((s) => s.status === "set");
  const allConnectionsConnected = connectionStates.every((c) => c.connected);
  const allReady = allSecretsSet && allConnectionsConnected;

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

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[#999]">
        <Loader2 className="w-4 h-4 animate-spin" />
        Checking existing secrets and connections...
      </div>
    );
  }

  const hasRequirements = requiredSecrets.length > 0 || requiredConnections.length > 0;
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
            Set up secrets and connections before creating the worker.
          </p>
        )}
        {skipped && (
          <p className="text-xs text-amber-600 mt-0.5">
            Skipped — you can configure these later in Settings / Connections.
          </p>
        )}
      </CardHeader>
      {!skipped && (
        <CardContent className="space-y-4">
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
}: {
  draft: DraftFromPromptResponse;
  originalPrompt: string;
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
  const [runPy, setRunPy] = useState(DEFAULT_RUN_PY);

  // Inline requirements state
  const [requirementsReady, setRequirementsReady] = useState(false);
  const [requirementsSkipped, setRequirementsSkipped] = useState(false);

  const hasRequirements =
    draft.required_secrets.length > 0 || draft.required_connections.length > 0;

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
    setSubmitting(true);
    try {
      const yamlToUse = activeTab === "yaml" ? workerYml : draft.worker_yml;
      const worker = await api.workers.create(yamlToUse, runPy);
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

            {/* Inline requirements — secrets + connections */}
            {hasRequirements && (
              <InlineRequirements
                requiredSecrets={draft.required_secrets}
                requiredConnections={draft.required_connections}
                onAllReady={handleRequirementsReady}
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-sm">Cron</Label>
                      <Input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} className="border-[#e4e4e7] font-mono text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-sm">Timezone</Label>
                      <Input value={cronTimezone} onChange={(e) => setCronTimezone(e.target.value)} className="border-[#e4e4e7] font-mono text-sm" />
                    </div>
                  </div>
                )}
                {triggerType === "webhook" && (
                  <div className="rounded-md border border-[#e4e4e7] bg-[#fafafa] p-3 text-sm text-[#555]">
                    Webhook trigger with per-worker HMAC signing enabled.
                  </div>
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

  const hasTemplate = Boolean(templateId && TEMPLATES[templateId]);

  if (hasTemplate) {
    return <OldFormContent templateId={templateId} />;
  }

  function handleDraft(d: DraftFromPromptResponse, prompt: string) {
    setDraft(d);
    setOriginalPrompt(prompt);
    setPageMode("form");
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
              : "Review the generated worker, then create it."}
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
        <PromptStep onDraft={handleDraft} />
      )}

      {pageMode === "form" && draft && (
        <ReviewStep
          draft={draft}
          originalPrompt={originalPrompt}
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
  const [composioTriggers, setComposioTriggers] = useState<ComposioTriggerItem[]>([]);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [triggerSearch, setTriggerSearch] = useState("");
  const [composioEvent, setComposioEvent] = useState("");
  const [composioConnectionId, setComposioConnectionId] = useState("");
  const [composioFilters, setComposioFilters] = useState("{}");

  useEffect(() => {
    Promise.all([
      api.integrations.triggers().catch(() => ({ items: [] })),
      api.connections.list().catch(() => []),
    ]).then(([triggerCatalog, connectionItems]) => {
      setComposioTriggers(triggerCatalog.items || []);
      setConnections(connectionItems);
    });
  }, []);

  const idError =
    workerId && !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(workerId)
      ? "Use lowercase letters, numbers, and hyphens. Start and end with a letter or number."
      : null;

  const selectedComposioTrigger = composioTriggers.find((item) => triggerEventId(item) === composioEvent);
  const selectedAppSlug = triggerAppSlug(selectedComposioTrigger);
  const matchingConnections = connections.filter((connection) => {
    if (connection.status !== "active") return false;
    if (!selectedAppSlug) return true;
    return connection.app_name.toLowerCase() === selectedAppSlug;
  });
  const filteredComposioTriggers = composioTriggers
    .filter((item) => {
      const haystack = `${triggerEventId(item)} ${triggerLabel(item)} ${triggerAppSlug(item)}`.toLowerCase();
      return haystack.includes(triggerSearch.toLowerCase());
    })
    .slice(0, 100);

  const yaml = buildYaml(
    workerId, name, description, inputs, outputs, secrets,
    triggerType, cronExpr, cronTimezone, composioEvent, composioConnectionId, composioFilters,
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
      if (!composioEvent) { toast.error("Composio event is required"); return; }
      if (!composioConnectionId) { toast.error("Connection ID is required"); return; }
      try { JSON.parse(composioFilters || "{}"); } catch { toast.error("Filters must be valid JSON"); return; }
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-sm">Cron</Label>
                    <Input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} className="border-[#e4e4e7] font-mono text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Timezone</Label>
                    <Input value={cronTimezone} onChange={(e) => setCronTimezone(e.target.value)} className="border-[#e4e4e7] font-mono text-sm" />
                  </div>
                </div>
              )}
              {triggerType === "webhook" && (
                <div className="rounded-md border border-[#e4e4e7] bg-[#fafafa] p-3 text-sm text-[#555]">
                  Webhook trigger with per-worker HMAC signing enabled.
                </div>
              )}
              {triggerType === "composio" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-sm">Search events</Label>
                    <Input placeholder="GMAIL_NEW_EMAIL, SLACK_MESSAGE_POSTED..." value={triggerSearch} onChange={(e) => setTriggerSearch(e.target.value)} className="border-[#e4e4e7]" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Event</Label>
                    <Select value={composioEvent} onValueChange={(value) => { if (!value) return; setComposioEvent(value); setComposioConnectionId(""); }}>
                      <SelectTrigger className="border-[#e4e4e7]">
                        <SelectValue placeholder="Select a connection event" />
                      </SelectTrigger>
                      <SelectContent>
                        {filteredComposioTriggers.map((item) => {
                          const eventId = triggerEventId(item);
                          return (
                            <SelectItem key={eventId} value={eventId}>
                              {triggerLabel(item)} · {eventId}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Connection ID</Label>
                    {matchingConnections.length > 0 ? (
                      <Select value={composioConnectionId} onValueChange={(value) => value && setComposioConnectionId(value)}>
                        <SelectTrigger className="border-[#e4e4e7]">
                          <SelectValue placeholder="Select connected account" />
                        </SelectTrigger>
                        <SelectContent>
                          {matchingConnections.map((connection) => (
                            <SelectItem key={connection.composio_connection_id} value={connection.composio_connection_id}>
                              {connection.app_name} · {connection.composio_connection_id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input placeholder="ca_xxx" value={composioConnectionId} onChange={(e) => setComposioConnectionId(e.target.value)} className="border-[#e4e4e7] font-mono text-sm" />
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Filters JSON</Label>
                    <Textarea value={composioFilters} onChange={(e) => setComposioFilters(e.target.value)} className="min-h-[90px] border-[#e4e4e7] font-mono text-xs" spellCheck={false} />
                  </div>
                </div>
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
