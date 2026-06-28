import { parse as parseYaml } from "yaml";

export type WorkerTemplate = {
  id: string;
  title: string;
  description: string;
  mode: "pure-script" | "agent";
  worker_yml: string;
  run_py?: string;
  skill_md?: string;
  notes: string[];
};

export type WorkerDraftValidationInput = {
  worker_yml: string;
  run_py?: string;
  skill_md?: string;
};

export type WorkerDraftValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  inferred: {
    mode: "pure-script" | "agent" | "unknown";
    entrypoint?: string;
    runtime?: string;
    runner?: string;
    declared_outputs: string[];
    declared_secrets: string[];
    declared_connections: string[];
    env_reads: string[];
  };
  next_steps: string[];
};

type JsonObject = Record<string, unknown>;

const SUPPORTED_RUNTIMES = new Set(["python311", "node22", "bash", "skill", "none"]);

export const WORKER_AUTHORING_CONTRACT = {
  schema_version: "0.3",
  required_files: ["worker.yml", "run.py or SKILL.md"],
  required_top_level_fields: ["schema_version", "name", "title", "description", "version", "exec", "trigger"],
  modes: {
    "pure-script": {
      entrypoint: "run.py",
      required_exec_fields: ["entry", "runtime", "runner", "command", "inputs", "outputs"],
      runtime_contract: [
        "Read inputs from inputs.json in the worker root.",
        "Write result.json in the worker root.",
        "result.json must be {\"status\":\"success\",\"outputs\":{...},\"artifacts\":[],\"error\":null}.",
        "Every declared scalar output must appear under result.json outputs.",
        "Every declared file output must write the declared path and include it in artifacts when applicable.",
      ],
    },
    agent: {
      entrypoint: "SKILL.md",
      required_exec_fields: ["entry", "runtime", "runner", "inputs", "outputs"],
      runtime_contract: [
        "Put the agent instructions in SKILL.md.",
        "Declare outputs in worker.yml so Floom can render and validate the result.",
        "Use connections, contexts, secrets, and approvals explicitly. Do not hide requirements in prose only.",
      ],
    },
  },
  secrets: [
    "Declare every environment variable read by code under capabilities.secrets.",
    "For compatibility, also declare secrets under top-level secrets or exec.secrets when the worker uses those legacy fields.",
    "Never model credentials as normal run inputs.",
  ],
  connections: [
    "Declare every integration under top-level connections.",
    "Use allowed_tools when the worker should only call specific Composio tools.",
    "Mirror connection names under capabilities.connections when the YAML includes a capabilities block.",
  ],
  validation_order: [
    "Start from workers.templates.get.",
    "Fill in worker.yml plus run.py or SKILL.md.",
    "Call workers.validate.",
    "Repair all errors before calling workers.create.",
    "After create, run only a safe smoke input and inspect runs.get/runs.watch.",
  ],
} as const;

export const WORKER_TEMPLATES: WorkerTemplate[] = [
  {
    id: "python-script",
    title: "Python Script Worker",
    description: "Deterministic E2B worker that reads inputs.json and writes result.json.",
    mode: "pure-script",
    worker_yml: `schema_version: "0.3"
name: text-normalizer
title: Text Normalizer
description: Normalize a text input and return the normalized value.
version: "0.1.0"
entrypoint: run.py
trigger:
  type: manual
exec:
  mode: pure-script
  entry: run.py
  runtime: python311
  runner: e2b
  command: python run.py
  inputs:
    - name: text
      label: Text
      type: string
      kind: scalar
      required: true
  outputs:
    - name: normalized
      label: Normalized text
      type: string
      kind: scalar
      required: true
capabilities:
  network:
    egress: false
  secrets: []
  connections: []
`,
    run_py: `import json
from pathlib import Path


def main() -> None:
    inputs_path = Path("inputs.json")
    inputs = json.loads(inputs_path.read_text(encoding="utf-8")) if inputs_path.exists() else {}
    text = str(inputs.get("text", "")).strip()
    result = {
        "status": "success",
        "outputs": {"normalized": " ".join(text.split())},
        "artifacts": [],
        "error": None,
    }
    Path("result.json").write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    main()
`,
    notes: [
      "Use this when the job can be completed deterministically in code.",
      "Keep declared outputs aligned with result.json outputs.",
    ],
  },
  {
    id: "gmail-summary-agent",
    title: "Gmail Summary Agent",
    description: "Agent-mode worker that uses a Gmail connection and produces a markdown summary.",
    mode: "agent",
    worker_yml: `schema_version: "0.3"
name: gmail-summary-agent
title: Gmail Summary Agent
description: Summarize recent Gmail messages into a concise markdown brief.
version: "0.1.0"
entrypoint: SKILL.md
trigger:
  type: manual
connections:
  - app: gmail
    allowed_tools:
      - GMAIL_FETCH_EMAILS
exec:
  mode: agent
  entry: SKILL.md
  runtime: python311
  runner: e2b
  inputs:
    - name: query
      label: Gmail query
      type: string
      kind: scalar
      required: false
      default: newer_than:1d
  outputs:
    - name: summary
      label: Summary
      type: markdown
      kind: file
      path: out/summary.md
      required: true
capabilities:
  network:
    egress: true
  secrets: []
  connections:
    - gmail
`,
    skill_md: `# Gmail Summary Agent

Fetch recent Gmail messages using the declared Gmail connection, summarize the important items, and write a markdown brief to out/summary.md.

Return the output named summary. Do not ask the user for OAuth tokens or passwords.
`,
    notes: [
      "Use agent mode when the work needs reasoning or tool calls.",
      "Declare every integration in connections and capabilities.connections.",
    ],
  },
  {
    id: "approval-script",
    title: "Approval Script Worker",
    description: "Script worker that prepares a human approval payload before an external action.",
    mode: "pure-script",
    worker_yml: `schema_version: "0.3"
name: approval-script
title: Approval Script
description: Build an approval payload for a proposed outbound action.
version: "0.1.0"
entrypoint: run.py
trigger:
  type: manual
exec:
  mode: pure-script
  entry: run.py
  runtime: python311
  runner: e2b
  command: python run.py
  inputs:
    - name: message
      label: Message
      type: string
      kind: scalar
      required: true
  outputs:
    - name: plan
      label: Approval plan
      type: markdown
      kind: file
      path: out/plan.md
      required: true
approvals:
  required: true
  label: Approve outbound action
capabilities:
  network:
    egress: false
  secrets: []
  connections: []
`,
    run_py: `import json
from pathlib import Path


def main() -> None:
    inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
    message = str(inputs.get("message", "")).strip()
    out_dir = Path("out")
    out_dir.mkdir(exist_ok=True)
    plan_path = out_dir / "plan.md"
    plan_path.write_text(f"# Proposed action\\n\\n{message}\\n", encoding="utf-8")
    result = {
        "status": "success",
        "outputs": {"plan": str(plan_path)},
        "artifacts": [{"name": "plan.md", "path": str(plan_path), "type": "text/markdown"}],
        "error": None,
    }
    Path("result.json").write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    main()
`,
    notes: [
      "Use approvals.required when a human must review before publication or side effects.",
      "Do not require secrets during the approval-plan phase unless the plan truly needs private API data.",
    ],
  },
];

export function listWorkerTemplates(): Array<Omit<WorkerTemplate, "worker_yml" | "run_py" | "skill_md">> {
  return WORKER_TEMPLATES.map(({ worker_yml: _workerYml, run_py: _runPy, skill_md: _skillMd, ...template }) => template);
}

export function getWorkerTemplate(id: string): WorkerTemplate | undefined {
  return WORKER_TEMPLATES.find((template) => template.id === id);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function fieldArray(manifest: JsonObject, key: "inputs" | "outputs"): JsonObject[] {
  const topLevel = Array.isArray(manifest[key]) ? manifest[key] : undefined;
  const exec = asRecord(manifest.exec);
  const execLevel = exec && Array.isArray(exec[key]) ? exec[key] : undefined;
  return (execLevel || topLevel || []).filter(isRecord);
}

function collectOutputNames(manifest: JsonObject): string[] {
  return fieldArray(manifest, "outputs")
    .map((item) => nonEmptyString(item.name))
    .filter((value): value is string => Boolean(value));
}

function collectConnectionNames(manifest: JsonObject): string[] {
  const raw = Array.isArray(manifest.connections) ? manifest.connections : [];
  const result = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      result.add(item.trim());
    } else if (isRecord(item)) {
      const app = nonEmptyString(item.app) || nonEmptyString(asRecord(item.composio)?.app);
      if (app) result.add(app);
    }
  }
  return [...result].sort();
}

function collectDeclaredSecrets(manifest: JsonObject): string[] {
  const result = new Set<string>();
  for (const key of stringList(manifest.secrets)) result.add(key);
  const exec = asRecord(manifest.exec);
  if (exec) {
    for (const key of stringList(exec.secrets)) result.add(key);
  }
  const capabilities = asRecord(manifest.capabilities);
  if (capabilities) {
    for (const key of stringList(capabilities.secrets)) result.add(key);
  }
  return [...result].sort();
}

function collectCapabilityList(manifest: JsonObject, key: "secrets" | "connections"): string[] {
  const capabilities = asRecord(manifest.capabilities);
  return capabilities ? stringList(capabilities[key]) : [];
}

function collectEnvReads(runPy: string): string[] {
  const result = new Set<string>();
  const patterns = [
    /\bos\.environ\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
    /\bos\.environ\.get\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    /\bos\.getenv\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of runPy.matchAll(pattern)) {
      result.add(match[1]);
    }
  }
  return [...result].sort();
}

function inferEntrypoint(manifest: JsonObject): string | undefined {
  const exec = asRecord(manifest.exec);
  return nonEmptyString(exec?.entry) || nonEmptyString(manifest.entrypoint);
}

function inferMode(manifest: JsonObject): "pure-script" | "agent" | "unknown" {
  const exec = asRecord(manifest.exec);
  const explicit = nonEmptyString(exec?.mode);
  const entry = inferEntrypoint(manifest);
  if (explicit === "agent" || entry === "SKILL.md") return "agent";
  if (explicit === "pure-script" || entry === "run.py") return "pure-script";
  return "unknown";
}

function parseManifest(workerYml: string): { manifest?: JsonObject; errors: string[] } {
  try {
    const parsed = parseYaml(workerYml);
    if (!isRecord(parsed)) {
      return { errors: ["worker.yml must be a YAML mapping"] };
    }
    return { manifest: parsed, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { errors: [`worker.yml is not valid YAML: ${message}`] };
  }
}

export function validateWorkerDraft(input: WorkerDraftValidationInput): WorkerDraftValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = parseManifest(input.worker_yml);
  errors.push(...parsed.errors);

  const manifest = parsed.manifest || {};
  const exec = asRecord(manifest.exec);
  const capabilities = asRecord(manifest.capabilities);
  const mode = parsed.manifest ? inferMode(manifest) : "unknown";
  const entrypoint = parsed.manifest ? inferEntrypoint(manifest) : undefined;
  const runtime = nonEmptyString(exec?.runtime) || nonEmptyString(asRecord(exec?.runtime)?.type);
  const runner = nonEmptyString(exec?.runner);
  const declaredOutputs = parsed.manifest ? collectOutputNames(manifest) : [];
  const declaredSecrets = parsed.manifest ? collectDeclaredSecrets(manifest) : [];
  const declaredConnections = parsed.manifest ? collectConnectionNames(manifest) : [];
  const envReads = collectEnvReads(input.run_py || "");

  if (parsed.manifest) {
    if (manifest.schema_version !== "0.3") errors.push('schema_version must be "0.3"');
    for (const field of ["name", "title", "description", "version"]) {
      if (!nonEmptyString(manifest[field])) errors.push(`worker.yml must include non-empty ${field}`);
    }
    if (!exec) {
      errors.push("worker.yml must include exec");
    } else {
      if (!entrypoint) errors.push("exec.entry or entrypoint is required");
      if (!runtime) errors.push("exec.runtime is required");
      if (runtime && !SUPPORTED_RUNTIMES.has(runtime)) {
        errors.push(`exec.runtime '${runtime}' is not supported; use one of ${[...SUPPORTED_RUNTIMES].join(", ")}`);
      }
      if (runner !== "e2b") errors.push('exec.runner must be "e2b"');
      if (!Array.isArray(exec.inputs)) errors.push("exec.inputs must be an array, even when empty");
      if (!Array.isArray(exec.outputs)) errors.push("exec.outputs must be an array, even when empty");
      if (mode === "pure-script" && !nonEmptyString(exec.command)) errors.push("pure-script workers must include exec.command");
    }

    const trigger = asRecord(manifest.trigger);
    if (!trigger) {
      errors.push("worker.yml must include trigger");
    } else if (!nonEmptyString(trigger.type)) {
      errors.push("trigger.type is required");
    }

    if (mode === "unknown") errors.push('worker mode is unknown; use exec.mode "pure-script" with run.py or "agent" with SKILL.md');
    if (mode === "pure-script" && entrypoint !== "run.py") errors.push('pure-script workers must use exec.entry: "run.py"');
    if (mode === "agent" && entrypoint !== "SKILL.md") errors.push('agent workers must use exec.entry: "SKILL.md"');

    for (const field of fieldArray(manifest, "inputs")) {
      if (!nonEmptyString(field.name)) errors.push("every input must include name");
      if (!nonEmptyString(field.type)) errors.push(`input ${nonEmptyString(field.name) || "<unnamed>"} must include type`);
    }
    for (const field of fieldArray(manifest, "outputs")) {
      if (!nonEmptyString(field.name)) errors.push("every output must include name");
      if (!nonEmptyString(field.type)) errors.push(`output ${nonEmptyString(field.name) || "<unnamed>"} must include type`);
    }

    const capSecrets = collectCapabilityList(manifest, "secrets");
    for (const key of envReads) {
      if (!capSecrets.includes(key)) {
        errors.push(`run.py reads env ${key}, but worker.yml does not declare it under capabilities.secrets`);
      }
    }

    const capConnections = collectCapabilityList(manifest, "connections");
    for (const connection of declaredConnections) {
      if (capabilities && !capConnections.includes(connection)) {
        warnings.push(`connection ${connection} is declared top-level but not mirrored under capabilities.connections`);
      }
    }
  }

  if (mode === "pure-script") {
    const runPy = input.run_py || "";
    if (!runPy.trim()) {
      errors.push("pure-script workers require non-empty run_py");
    } else {
      if (!/result\.json/.test(runPy)) {
        errors.push("pure-script run.py must write result.json");
      }
      if (/^\s*def\s+run\s*\(\s*inputs\s*,\s*context\s*\)\s*:/m.test(runPy) && /^\s*return\b/m.test(runPy) && !/result\.json/.test(runPy)) {
        errors.push("pure-script run.py must not rely on SDK-style def run() return values; write result.json instead");
      }
      if (declaredOutputs.length > 0 && /["']outputs["']\s*:\s*\{\s*\}/.test(runPy)) {
        errors.push("run.py writes an empty outputs object, but worker.yml declares outputs");
      }
      for (const output of declaredOutputs) {
        if (!new RegExp(`["']${output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(runPy)) {
          errors.push(`declared output ${output} does not appear in run.py; result.json.outputs must include every declared output`);
        }
      }
    }
    if (input.skill_md?.trim()) warnings.push("skill_md is ignored for pure-script workers");
  }

  if (mode === "agent") {
    if (!input.skill_md?.trim()) errors.push("agent workers require non-empty skill_md / SKILL.md");
    if (input.run_py?.trim()) warnings.push("agent workers execute SKILL.md; run_py should be omitted unless the API requires a compatibility stub");
  }

  const nextSteps = errors.length > 0
    ? ["Fix every validation error.", "Call workers.validate again before workers.create."]
    : ["Call workers.create with this exact worker_yml plus run_py or skill_md.", "Run a safe smoke input, then inspect runs.get/runs.watch."];

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    inferred: {
      mode,
      entrypoint,
      runtime,
      runner,
      declared_outputs: declaredOutputs,
      declared_secrets: declaredSecrets,
      declared_connections: declaredConnections,
      env_reads: envReads,
    },
    next_steps: nextSteps,
  };
}
