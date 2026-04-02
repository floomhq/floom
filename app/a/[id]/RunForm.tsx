"use client";

import { useState, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Play, Loader2 } from "lucide-react";

type ManifestInput = {
  name: string;
  label: string;
  type: "text" | "textarea" | "url" | "file" | "integer" | "enum";
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

export function RunForm({
  manifest,
  onRun,
  automationId,
}: {
  manifest: Manifest | null;
  onRun: (inputs: Record<string, unknown>) => Promise<void>;
  automationId: string;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [fileUploads, setFileUploads] = useState<Record<string, "idle" | "uploading" | "ready" | "error">>({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const getUploadUrl = useAction(api.files.getUploadUrl);

  const inputs = manifest?.inputs ?? [];

  function validate(): boolean {
    const newErrors: Record<string, string> = {};
    for (const input of inputs) {
      if (input.required !== false && !values[input.name]) {
        if (input.type === "file" && !values[input.name]) {
          newErrors[input.name] = "Required";
        } else if (!values[input.name] && values[input.name] !== 0) {
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
      const { uploadUrl, fileUrl } = await getUploadUrl({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
      });

      const res = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });

      if (!res.ok) throw new Error("Upload failed");

      setValues((p) => ({ ...p, [input.name]: fileUrl }));
      setFileUploads((p) => ({ ...p, [input.name]: "ready" }));
    } catch {
      setFileUploads((p) => ({ ...p, [input.name]: "error" }));
    }
  }

  if (inputs.length === 0) {
    return (
      <div className="p-6 flex flex-col items-center justify-center h-full min-h-[200px] text-gray-400">
        <p className="text-sm">No inputs required.</p>
        <button
          onClick={() => onRun({})}
          disabled={running}
          className="mt-4 flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          {running ? "Running..." : "Run Now"}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="p-4 space-y-4">
      {inputs.map((input) => (
        <div key={input.name}>
          <label className="block text-sm font-semibold text-gray-700 mb-1">
            {input.label}
            {input.required !== false && (
              <span className="text-red-500 ml-1">*</span>
            )}
          </label>
          {input.description && (
            <p className="text-xs text-gray-500 mb-1">{input.description}</p>
          )}

          {input.type === "text" && (
            <input
              type="text"
              value={(values[input.name] as string) ?? ""}
              onChange={(e) =>
                setValues((p) => ({ ...p, [input.name]: e.target.value }))
              }
              className={`w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                errors[input.name] ? "border-red-400" : "border-gray-300"
              }`}
            />
          )}

          {input.type === "textarea" && (
            <div className="relative">
              <textarea
                value={(values[input.name] as string) ?? ""}
                onChange={(e) =>
                  setValues((p) => ({ ...p, [input.name]: e.target.value }))
                }
                rows={4}
                maxLength={10000}
                className={`w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y min-h-[96px] max-h-[288px] ${
                  errors[input.name] ? "border-red-400" : "border-gray-300"
                }`}
                onFocus={(e) => {
                  // Expand on focus (mobile: fullscreen overlay effect)
                  e.target.style.maxHeight = "none";
                }}
                onBlur={(e) => {
                  e.target.style.maxHeight = "288px";
                }}
              />
              <span className="absolute bottom-2 right-2 text-xs text-gray-400 pointer-events-none">
                {((values[input.name] as string) ?? "").length} / 10,000
              </span>
            </div>
          )}

          {input.type === "url" && (
            <input
              type="url"
              value={(values[input.name] as string) ?? ""}
              onChange={(e) =>
                setValues((p) => ({ ...p, [input.name]: e.target.value }))
              }
              className={`w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                errors[input.name] ? "border-red-400" : "border-gray-300"
              }`}
              placeholder="https://"
            />
          )}

          {input.type === "integer" && (
            <input
              type="number"
              value={(values[input.name] as number) ?? (input.default as number) ?? ""}
              onChange={(e) =>
                setValues((p) => ({ ...p, [input.name]: parseInt(e.target.value) || 0 }))
              }
              min={input.min}
              max={input.max}
              className={`w-32 px-3 py-2 border rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                errors[input.name] ? "border-red-400" : "border-gray-300"
              }`}
            />
          )}

          {input.type === "enum" && (
            <select
              value={(values[input.name] as string) ?? (input.default as string) ?? ""}
              onChange={(e) =>
                setValues((p) => ({ ...p, [input.name]: e.target.value }))
              }
              className={`px-3 py-2 border rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                errors[input.name] ? "border-red-400" : "border-gray-300"
              }`}
            >
              {!input.default && <option value="">Select...</option>}
              {input.options?.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
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
            <p className="text-xs text-red-500 mt-1">{errors[input.name]}</p>
          )}
        </div>
      ))}

      <button
        type="submit"
        disabled={running}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {running ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Play size={16} />
        )}
        {running ? "Running..." : "Run Now"}
      </button>
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
      className={`border-2 border-dashed rounded p-4 text-center cursor-pointer transition-colors ${
        state === "idle" ? "border-gray-300 hover:border-blue-400" :
        state === "ready" ? "border-emerald-400 bg-emerald-50" :
        state === "error" ? "border-red-400 bg-red-50" :
        "border-blue-300 bg-blue-50"
      }`}
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
        <p className="text-sm text-gray-500">
          Drop file here or click to upload
          {input.accept && (
            <span className="block text-xs mt-1 text-gray-400">
              Accepts: {input.accept}
            </span>
          )}
        </p>
      )}
      {state === "uploading" && (
        <p className="text-sm text-blue-600">Uploading...</p>
      )}
      {state === "ready" && (
        <div className="flex items-center justify-center gap-2 text-sm text-emerald-700">
          <span>{fileName} ✓</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            className="text-gray-400 hover:text-gray-600 ml-2"
          >
            ×
          </button>
        </div>
      )}
      {state === "error" && (
        <p className="text-sm text-red-600">Upload failed — try again</p>
      )}
    </div>
  );
}
