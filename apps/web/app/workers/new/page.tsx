"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";

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

function yamlString(value: string): string {
  return JSON.stringify(value);
}

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
  approvalsRequired: boolean,
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
  lines.push(`approvals:`);
  lines.push(`  required: ${approvalsRequired}`);
  lines.push(``);
  lines.push(`trigger:`);
  lines.push(`  type: manual`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function NewWorkerPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [workerId, setWorkerId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [inputs, setInputs] = useState<InputRow[]>([]);
  const [outputs, setOutputs] = useState<OutputRow[]>([]);
  const [secrets, setSecrets] = useState("");
  const [approvalsRequired, setApprovalsRequired] = useState(false);
  const [runPy, setRunPy] = useState(DEFAULT_RUN_PY);

  // ID validation
  const idError =
    workerId && !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(workerId)
      ? "Use lowercase letters, numbers, and hyphens. Start and end with a letter or number."
      : null;

  const yaml = buildYaml(workerId, name, description, inputs, outputs, secrets, approvalsRequired);

  // Input row helpers
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

  // Output row helpers
  const addOutput = useCallback(() => {
    setOutputs((prev) => [
      ...prev,
      { name: "", label: "", type: "markdown" },
    ]);
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
        {/* Left: form */}
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
                  placeholder="my-worker"
                  value={workerId}
                  onChange={(e) => setWorkerId(e.target.value.toLowerCase().replace(/[\s_]+/g, "-"))}
                  className={`border-[#e4e4e7] font-mono ${idError ? "border-red-400" : ""}`}
                />
                {idError && <p className="text-xs text-red-500">{idError}</p>}
                <p className="text-xs text-[#999]">Lowercase slug. E.g. my-worker, lead-enricher</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">
                  Name <span className="text-red-500">*</span>
                </Label>
                <Input
                  placeholder="My Worker"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="border-[#e4e4e7]"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Description</Label>
                <Textarea
                  placeholder="What does this worker do?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="min-h-[60px] border-[#e4e4e7]"
                />
              </div>
            </CardContent>
          </Card>

          {/* Inputs */}
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Inputs</CardTitle>
                <Button variant="ghost" size="sm" onClick={addInput} className="h-7 px-2 text-xs">
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add input
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {inputs.length === 0 && (
                <p className="text-sm text-[#999]">No inputs yet. Add one above.</p>
              )}
              {inputs.map((inp, idx) => (
                <div key={idx} className="space-y-2 p-3 bg-[#f9f9f9] rounded-md">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-[#666]">Input {idx + 1}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeInput(idx)}
                      className="h-6 w-6 p-0 text-[#999] hover:text-red-500"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Name</Label>
                      <Input
                        placeholder="my_field"
                        value={inp.name}
                        onChange={(e) => updateInput(idx, "name", e.target.value)}
                        className="h-7 text-xs border-[#e4e4e7] font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Label</Label>
                      <Input
                        placeholder="My Field"
                        value={inp.label}
                        onChange={(e) => updateInput(idx, "label", e.target.value)}
                        className="h-7 text-xs border-[#e4e4e7]"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Type</Label>
                      <Select
                        value={inp.type}
                        onValueChange={(v) => updateInput(idx, "type", v)}
                      >
                        <SelectTrigger className="h-7 text-xs border-[#e4e4e7]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {INPUT_TYPES.map((t) => (
                            <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Placeholder</Label>
                      <Input
                        placeholder="e.g. Enter value..."
                        value={inp.placeholder}
                        onChange={(e) => updateInput(idx, "placeholder", e.target.value)}
                        className="h-7 text-xs border-[#e4e4e7]"
                      />
                    </div>
                  </div>
                  {inp.type === "select" && (
                    <div className="space-y-1">
                      <Label className="text-xs">Options</Label>
                      <Input
                        placeholder="alpha, beta, gamma"
                        value={inp.options}
                        onChange={(e) => updateInput(idx, "options", e.target.value)}
                        className="h-7 text-xs border-[#e4e4e7]"
                      />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label className="text-xs">Help text</Label>
                    <Input
                      placeholder="Shown below the field label"
                      value={inp.description}
                      onChange={(e) => updateInput(idx, "description", e.target.value)}
                      className="h-7 text-xs border-[#e4e4e7]"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`inp-req-${idx}`}
                      checked={inp.required}
                      onChange={(e) => updateInput(idx, "required", e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-[#e4e4e7] accent-black cursor-pointer"
                    />
                    <label htmlFor={`inp-req-${idx}`} className="text-xs text-[#666] cursor-pointer">
                      Required
                    </label>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Outputs */}
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Outputs</CardTitle>
                <Button variant="ghost" size="sm" onClick={addOutput} className="h-7 px-2 text-xs">
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add output
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {outputs.length === 0 && (
                <p className="text-sm text-[#999]">No outputs yet. Add one above.</p>
              )}
              {outputs.map((out, idx) => (
                <div key={idx} className="space-y-2 p-3 bg-[#f9f9f9] rounded-md">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-[#666]">Output {idx + 1}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeOutput(idx)}
                      className="h-6 w-6 p-0 text-[#999] hover:text-red-500"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Name</Label>
                      <Input
                        placeholder="result"
                        value={out.name}
                        onChange={(e) => updateOutput(idx, "name", e.target.value)}
                        className="h-7 text-xs border-[#e4e4e7] font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Label</Label>
                      <Input
                        placeholder="Result"
                        value={out.label}
                        onChange={(e) => updateOutput(idx, "label", e.target.value)}
                        className="h-7 text-xs border-[#e4e4e7]"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Type</Label>
                    <Select
                      value={out.type}
                      onValueChange={(v) => updateOutput(idx, "type", v)}
                    >
                      <SelectTrigger className="h-7 text-xs border-[#e4e4e7]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OUTPUT_TYPES.map((t) => (
                          <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Secrets + Approvals */}
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Secrets & approvals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-sm">Secrets</Label>
                <Input
                  placeholder="OPENAI_API_KEY, APOLLO_API_KEY"
                  value={secrets}
                  onChange={(e) => setSecrets(e.target.value)}
                  className="border-[#e4e4e7] font-mono text-sm"
                />
                <p className="text-xs text-[#999]">Comma-separated env var names this worker needs.</p>
              </div>
              <Separator />
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="approvals-required"
                  checked={approvalsRequired}
                  onChange={(e) => setApprovalsRequired(e.target.checked)}
                  className="w-4 h-4 rounded border-[#e4e4e7] accent-black cursor-pointer"
                />
                <label htmlFor="approvals-required" className="text-sm text-[#333] cursor-pointer select-none">
                  Require approval before completing
                </label>
              </div>
            </CardContent>
          </Card>

          {/* run.py */}
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
            onClick={handleSubmit}
            disabled={submitting || !workerId || !name || !!idError}
            className="w-full"
          >
            {submitting ? "Creating..." : "Create worker"}
          </Button>
        </div>

        {/* Right: YAML preview */}
        <div className="sticky top-6">
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">worker.yml preview</CardTitle>
            </CardHeader>
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
        // Match key: value pattern
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
        // List items
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
        // Empty line or fallback
        return <div key={i}>{line || " "}</div>;
      })}
    </pre>
  );
}
