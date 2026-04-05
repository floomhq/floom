// Manifest validation — enforces all 5 invariants before deploy/update.

export type ManifestInput = {
  name: string;
  label: string;
  type: "text" | "textarea" | "url" | "file" | "number" | "enum" | "boolean" | "date";
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: string[]; // for enum
  accept?: string; // for file
  min?: number; // for number
  max?: number; // for number
};

export type ManifestOutput = {
  name: string;
  label: string;
  type: "text" | "table" | "number" | "html" | "pdf" | "image";
  columns?: string[]; // for table
};

export type Manifest = {
  name: string;
  description: string;
  schedule?: string | null;
  scheduleInputs?: Record<string, unknown> | null;
  inputs: ManifestInput[];
  outputs: ManifestOutput[];
  secrets_needed: string[];
  python_dependencies: string[];
  manifest_version?: string;
};

export type ValidationError = {
  code:
    | "syntax_error"
    | "output_mismatch"
    | "input_mismatch"
    | "missing_secret"
    | "exec_globals";
  message: string;
};

// Validate manifest structure (not secrets — those require DB access).
export function validateManifestStructure(
  code: string,
  manifest: Manifest
): ValidationError | null {
  const VALID_INPUT_TYPES = new Set(["text", "textarea", "url", "file", "number", "enum", "boolean", "date"]);
  const VALID_OUTPUT_TYPES = new Set(["text", "table", "number", "html", "pdf", "image"]);

  for (const input of manifest.inputs) {
    if (!VALID_INPUT_TYPES.has(input.type)) {
      return { code: "input_mismatch" as const, message: `Unknown input type "${input.type}"` };
    }
  }
  for (const output of manifest.outputs) {
    if (!VALID_OUTPUT_TYPES.has(output.type)) {
      return { code: "output_mismatch" as const, message: `Unknown output type "${output.type}"` };
    }
  }

  // 1. No exec(..., globals()) usage
  if (/exec\s*\(.*globals\s*\(\s*\)/.test(code)) {
    return {
      code: "exec_globals",
      message:
        "Code must not use exec(..., globals()). Use subprocess isolation instead.",
    };
  }

  // 2. Input names match function parameter names
  const paramMatch = code.match(/def\s+run\s*\(([^)]*)\)/);
  if (paramMatch) {
    const params = paramMatch[1]
      .split(",")
      .map((p) => p.trim().split(/[=:]/)[0].trim())
      .filter(Boolean);

    for (const input of manifest.inputs) {
      if (input.required !== false && !params.includes(input.name)) {
        return {
          code: "input_mismatch",
          message: `Input "${input.name}" not found in function parameters. Function signature: run(${params.join(", ")})`,
        };
      }
    }
  }

  return null;
}

// Validate cron string format.
export function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  return parts.length === 5;
}

// Select the best E2B template based on dependencies.
// Uses E2B's built-in base template — custom templates can be swapped in later.
export function selectE2BTemplate(_deps: string[]): string {
  return "base";
}
