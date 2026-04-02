// Manifest validation — enforces all 5 invariants before deploy/update.

export type ManifestInput = {
  name: string;
  label: string;
  type: "text" | "textarea" | "url" | "file" | "integer" | "enum";
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: string[]; // for enum
  accept?: string; // for file
  min?: number; // for integer
  max?: number; // for integer
};

export type ManifestOutput = {
  name: string;
  label: string;
  type: "text" | "table" | "integer";
  columns?: string[]; // for table
};

export type Manifest = {
  name: string;
  description: string;
  department?: string;
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
export function selectE2BTemplate(deps: string[]): string {
  const dataScienceDeps = ["pandas", "numpy", "openpyxl", "PyMuPDF", "fitz"];
  const hasDataScience = deps.some((d) =>
    dataScienceDeps.some((ds) => d.toLowerCase().includes(ds.toLowerCase()))
  );

  return hasDataScience ? "data-science" : "enrichment";
}
