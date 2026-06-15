"use client";

// Generic input form driven by a worker's declared inputs schema.
// Handles: text/string (single-line or multiline), select, boolean, file
// (with CSV mapper when accept_csv=true), and number.
// Reuses the same components and heuristics as the /workers/[id] Run tab —
// single source of truth via these shared primitives. No bespoke chrome.
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CsvColumnMapper } from "@/components/csv-column-mapper";
import { FileInputUpload } from "@/components/FileInputUpload";
import type { WorkerInput } from "@/lib/types";

// Mirror of the heuristic in /workers/[id]/page.tsx (same DRY rule: the
// heuristic lives here; /workers/[id] can import it in a future refactor).
const MULTILINE_HINT =
  /(instruction|brief|notes?|summary|prompt|message|context|description|details|jd|paste|body|content)/i;

function isMultilineText(inp: WorkerInput): boolean {
  return (
    (inp.type === "text" || inp.type === "string") &&
    (MULTILINE_HINT.test(inp.name) || MULTILINE_HINT.test(inp.label || ""))
  );
}

function isLongInput(inp: WorkerInput): boolean {
  return inp.type === "textarea" || inp.type === "file" || isMultilineText(inp);
}

function humanizeOptionLabel(opt: string): string {
  return opt.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isRequiredRunInputMissing(
  input: WorkerInput,
  value: unknown,
): boolean {
  if (!input.required) return false;
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function requiredRunInputErrors(
  inputDefs: WorkerInput[] = [],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const input of inputDefs) {
    if (isRequiredRunInputMissing(input, values[input.name])) {
      errors[input.name] = "Required";
    }
  }
  return errors;
}

interface WorkerInputFormProps {
  inputs: WorkerInput[];
  values: Record<string, unknown>;
  fileNames?: Record<string, string>;
  validationErrors?: Record<string, string>;
  onInputChange: (name: string, value: unknown) => void;
  onFileUploaded?: (name: string, sha256: string, fileName: string) => void;
  csvRequiredColumns?: string[];
}

export function WorkerInputForm({
  inputs,
  values,
  fileNames = {},
  validationErrors = {},
  onInputChange,
  onFileUploaded,
  csvRequiredColumns = [],
}: WorkerInputFormProps) {
  if (inputs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This worker takes no inputs.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {inputs.map((inp) => (
        <div
          key={inp.name}
          className={`space-y-1.5 ${isLongInput(inp) ? "sm:col-span-2" : ""}`}
        >
          <Label className="text-sm">
            {inp.label}
            {inp.required && (
              <span className="text-red-500 ml-0.5">*</span>
            )}
          </Label>
          {inp.description && (
            <p className="text-xs text-muted-foreground">{inp.description}</p>
          )}

          {inp.type === "textarea" || isMultilineText(inp) ? (
            <Textarea
              placeholder={inp.placeholder}
              value={(values[inp.name] as string) || ""}
              onChange={(e) => onInputChange(inp.name, e.target.value)}
              className="min-h-[100px] border-border"
              aria-invalid={Boolean(validationErrors[inp.name])}
            />
          ) : inp.type === "select" ? (
            <Select
              value={
                (values[inp.name] as string) ||
                (inp.default as string) ||
                ""
              }
              onValueChange={(val) => onInputChange(inp.name, val)}
            >
              <SelectTrigger
                className="border-border w-full"
                aria-invalid={Boolean(validationErrors[inp.name])}
              >
                <SelectValue
                  placeholder={inp.placeholder || "Select an option"}
                />
              </SelectTrigger>
              <SelectContent>
                {(inp.options || []).map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {humanizeOptionLabel(opt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : inp.type === "boolean" ? (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`inp-${inp.name}`}
                checked={
                  values[inp.name] === true ||
                  values[inp.name] === "true"
                }
                onChange={(e) =>
                  onInputChange(inp.name, e.target.checked)
                }
                className="w-4 h-4 rounded border-border accent-black cursor-pointer"
                aria-invalid={Boolean(validationErrors[inp.name])}
              />
              <label
                htmlFor={`inp-${inp.name}`}
                className="text-sm text-muted-foreground cursor-pointer select-none"
              >
                {inp.placeholder || inp.label}
              </label>
            </div>
          ) : inp.type === "file" && inp.accept_csv ? (
            <CsvColumnMapper
              requiredColumns={csvRequiredColumns}
              label={undefined}
              onMapped={(csv) => onInputChange(inp.name, csv)}
            />
          ) : inp.type === "file" ? (
            <FileInputUpload
              name={inp.name}
              value={values[inp.name] as string | undefined}
              fileName={fileNames[inp.name]}
              accepts={inp.accepts}
              maxSizeMb={inp.max_size_mb}
              onUploaded={(sha256, name) => {
                onFileUploaded?.(inp.name, sha256, name);
              }}
            />
          ) : (
            <Input
              type={inp.type === "number" ? "number" : "text"}
              placeholder={inp.placeholder}
              value={(values[inp.name] as string) || ""}
              onChange={(e) => onInputChange(inp.name, e.target.value)}
              className="border-border"
              aria-invalid={Boolean(validationErrors[inp.name])}
            />
          )}

          {validationErrors[inp.name] && (
            <p className="text-xs text-red-600">{validationErrors[inp.name]}</p>
          )}
        </div>
      ))}
    </div>
  );
}
