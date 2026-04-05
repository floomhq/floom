"use client";

import { useState, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Play, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

type ManifestInput = {
  name: string;
  label: string;
  type: "text" | "textarea" | "url" | "file" | "number" | "enum" | "boolean" | "date";
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
  accept?: string;
  min?: number;
  max?: number;
};

type Manifest = {
  inputs: ManifestInput[];
};

type GetUploadUrlFn = (args: {
  filename: string;
  contentType: string;
}) => Promise<{ uploadUrl: string; fileKey: string }>;

export function RunForm({
  manifest,
  onRun,
  automationId,
  isRunning = false,
  getUploadUrlAction,
}: {
  manifest: Manifest | null;
  onRun: (inputs: Record<string, unknown>) => Promise<void>;
  automationId: string;
  isRunning?: boolean;
  getUploadUrlAction?: GetUploadUrlFn;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const input of manifest?.inputs ?? []) {
      if (input.type === "boolean") {
        initial[input.name] = (input.default as boolean) ?? false;
      }
    }
    return initial;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [fileUploads, setFileUploads] = useState<
    Record<string, "idle" | "uploading" | "ready" | "error">
  >({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const defaultGetUploadUrl = useAction(api.files.getUploadUrl);
  const getUploadUrl = getUploadUrlAction ?? defaultGetUploadUrl;

  const inputs = manifest?.inputs ?? [];

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    for (const input of inputs) {
      if (input.required !== false && !values[input.name]) {
        if (input.type === "file" && !values[input.name]) {
          newErrors[input.name] = "Required";
        } else if (!values[input.name] && values[input.name] !== 0 && values[input.name] !== false) {
          newErrors[input.name] = "Required";
        }
      }
      if (input.type === "url" && values[input.name]) {
        try {
          new URL(values[input.name] as string);
        } catch {
          newErrors[input.name] = "Must be a valid URL";
        }
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setRunning(true);
    try {
      await onRun(values as Record<string, unknown>);
    } finally {
      setRunning(false);
    }
  }

  async function handleFileUpload(input: ManifestInput, file: File) {
    setFileUploads((p) => ({ ...p, [input.name]: "uploading" }));
    setFileNames((p) => ({ ...p, [input.name]: file.name }));

    try {
      const { uploadUrl, fileKey } = await getUploadUrl({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
      });

      const res = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });

      if (!res.ok) throw new Error("Upload failed");

      setValues((p) => ({ ...p, [input.name]: fileKey }));
      setFileUploads((p) => ({ ...p, [input.name]: "ready" }));
    } catch {
      setFileUploads((p) => ({ ...p, [input.name]: "error" }));
    }
  }

  if (inputs.length === 0) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground">
        <p className="text-sm">No inputs required.</p>
        <Button
          onClick={() => onRun({})}
          disabled={running || isRunning}
          className="mt-4"
        >
          {running || isRunning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          {running || isRunning ? "Running..." : "Run Now"}
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="p-4 space-y-4">
      {inputs.map((input) => (
        <div key={input.name} className="space-y-1.5">
          <Label>
            {input.label}
            {input.required !== false && (
              <span className="text-destructive ml-1">*</span>
            )}
          </Label>
          {input.description && (
            <p className="text-xs text-muted-foreground">
              {input.description}
            </p>
          )}

          {input.type === "text" && (
            <Input
              type="text"
              value={(values[input.name] as string) ?? ""}
              onChange={(e) =>
                setValues((p) => ({ ...p, [input.name]: e.target.value }))
              }
              aria-invalid={!!errors[input.name]}
            />
          )}

          {input.type === "textarea" && (
            <div className="relative">
              <Textarea
                value={(values[input.name] as string) ?? ""}
                onChange={(e) =>
                  setValues((p) => ({ ...p, [input.name]: e.target.value }))
                }
                rows={4}
                maxLength={10000}
                aria-invalid={!!errors[input.name]}
                className="resize-y min-h-[96px] max-h-[288px]"
                onFocus={(e) => {
                  e.target.style.maxHeight = "none";
                }}
                onBlur={(e) => {
                  e.target.style.maxHeight = "288px";
                }}
              />
              <span className="absolute bottom-2 right-2 text-xs text-muted-foreground pointer-events-none">
                {((values[input.name] as string) ?? "").length} / 10,000
              </span>
            </div>
          )}

          {input.type === "url" && (
            <Input
              type="url"
              value={(values[input.name] as string) ?? ""}
              onChange={(e) =>
                setValues((p) => ({ ...p, [input.name]: e.target.value }))
              }
              placeholder="https://"
              aria-invalid={!!errors[input.name]}
            />
          )}

          {input.type === "number" && (
            <Input
              type="number"
              value={
                (values[input.name] as number) ??
                (input.default as number) ??
                ""
              }
              onChange={(e) =>
                setValues((p) => ({
                  ...p,
                  [input.name]: e.target.value === "" ? undefined : parseFloat(e.target.value),
                }))
              }
              step="any"
              min={input.min}
              max={input.max}
              aria-invalid={!!errors[input.name]}
              className="w-32"
            />
          )}

          {input.type === "enum" && (
            <Select
              value={
                (values[input.name] as string) ??
                (input.default as string) ??
                ""
              }
              onValueChange={(val) =>
                setValues((p) => ({ ...p, [input.name]: val }))
              }
            >
              <SelectTrigger
                aria-invalid={!!errors[input.name]}
                className="w-full"
              >
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent>
                {input.options?.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {input.type === "boolean" && (
            <Switch
              checked={(values[input.name] as boolean) ?? (input.default as boolean) ?? false}
              onCheckedChange={(checked) =>
                setValues((p) => ({ ...p, [input.name]: checked }))
              }
            />
          )}

          {input.type === "date" && (
            <Input
              type="date"
              value={(values[input.name] as string) ?? (input.default as string) ?? ""}
              onChange={(e) =>
                setValues((p) => ({ ...p, [input.name]: e.target.value }))
              }
              className="w-48"
            />
          )}

          {input.type === "file" && (
            <FileDropzone
              input={input}
              state={fileUploads[input.name] ?? "idle"}
              fileName={fileNames[input.name]}
              onFile={(file) => handleFileUpload(input, file)}
              onClear={() => {
                setValues((p) => ({ ...p, [input.name]: undefined }));
                setFileUploads((p) => ({ ...p, [input.name]: "idle" }));
                setFileNames((p) => ({ ...p, [input.name]: "" }));
              }}
            />
          )}

          {errors[input.name] && (
            <p className="text-xs text-destructive">{errors[input.name]}</p>
          )}
        </div>
      ))}

      <Button
        type="submit"
        disabled={running || isRunning}
        className="w-full"
      >
        {running || isRunning ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
        {running || isRunning ? "Running..." : "Run Now"}
      </Button>
    </form>
  );
}

function FileDropzone({
  input,
  state,
  fileName,
  onFile,
  onClear,
}: {
  input: ManifestInput;
  state: "idle" | "uploading" | "ready" | "error";
  fileName?: string;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  return (
    <div
      className={cn(
        "rounded-lg border-2 border-dashed p-4 text-center cursor-pointer transition-colors",
        state === "idle" && "border-border hover:border-ring",
        state === "ready" && "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/20",
        state === "error" && "border-destructive bg-destructive/5",
        state === "uploading" && "border-ring bg-ring/5"
      )}
      onClick={() => state === "idle" && ref.current?.click()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
      onDragOver={(e) => e.preventDefault()}
    >
      <input
        ref={ref}
        type="file"
        className="hidden"
        accept={input.accept}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
        }}
      />
      {state === "idle" && (
        <p className="text-sm text-muted-foreground">
          Drop file here or click to upload
          {input.accept && (
            <span className="block text-xs mt-1 text-muted-foreground/60">
              Accepts: {input.accept}
            </span>
          )}
        </p>
      )}
      {state === "uploading" && (
        <p className="text-sm text-primary">Uploading...</p>
      )}
      {state === "ready" && (
        <div className="flex items-center justify-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
          <span>{fileName} ✓</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
          >
            <X className="size-3" />
          </Button>
        </div>
      )}
      {state === "error" && (
        <p className="text-sm text-destructive">Upload failed — try again</p>
      )}
    </div>
  );
}
