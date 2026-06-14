"use client";

import { useRef, useState } from "react";
import { FileText, UploadCloud } from "lucide-react";
import { apiProxyPath } from "@/lib/api";

type UploadResponse = {
  id: string;
  sha256: string;
  size: number;
  media_type: string;
};

type Props = {
  name: string;
  value?: string;
  fileName?: string;
  accepts?: string[];
  maxSizeMb?: number;
  onUploaded: (sha256: string, fileName: string, upload: UploadResponse) => void;
};

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function uploadEndpointPath(): string {
  return apiProxyPath("/uploads");
}

export function FileInputUpload({ name, value, fileName, accepts, maxSizeMb, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpload, setLastUpload] = useState<UploadResponse | null>(null);

  const acceptAttr = accepts?.length ? accepts.join(",") : undefined;

  function upload(file: File) {
    setError(null);
    setUploading(true);
    setProgress(0);

    const form = new FormData();
    form.append("file", file);
    if (maxSizeMb) form.append("max_size_mb", String(maxSizeMb));
    if (accepts?.length) form.append("accepts", JSON.stringify(accepts));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", uploadEndpointPath());
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setProgress(Math.max(1, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      setUploading(false);
      setProgress(100);
      if (xhr.status < 200 || xhr.status >= 300) {
        try {
          const parsed = JSON.parse(xhr.responseText);
          setError(parsed.detail || "Upload failed");
        } catch {
          setError("Upload failed");
        }
        return;
      }
      const parsed = JSON.parse(xhr.responseText) as UploadResponse;
      setLastUpload(parsed);
      onUploaded(parsed.sha256, file.name, parsed);
    };
    xhr.onerror = () => {
      setUploading(false);
      setError("Upload failed");
    };
    xhr.send(form);
  }

  function pickFile(file: File | undefined) {
    if (!file) return;
    if (maxSizeMb && file.size > maxSizeMb * 1024 * 1024) {
      setError(`File exceeds ${maxSizeMb} MB`);
      return;
    }
    upload(file);
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className={`relative w-full rounded-[var(--radius-ui)] p-4 text-left transition-colors ${
          dragging ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]" : "hover:bg-muted/40"
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          pickFile(event.dataTransfer.files?.[0]);
        }}
      >
        <input
          ref={inputRef}
          id={`file-input-${name}`}
          type="file"
          accept={acceptAttr}
          className="hidden"
          onChange={(event) => pickFile(event.target.files?.[0])}
        />
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-ui)] bg-muted text-muted-foreground">
            {value ? <FileText className="h-4 w-4" /> : <UploadCloud className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {fileName || (uploading ? "Uploading..." : "Drop a file or click to browse")}
            </p>
            <p className="text-xs text-muted-foreground">
              {lastUpload
                ? `${formatBytes(lastUpload.size)} · ${lastUpload.media_type}`
                : maxSizeMb
                ? `Max ${maxSizeMb} MB`
                : accepts?.length
                ? accepts.join(", ")
                : "Upload stores a SHA-256 file reference"}
            </p>
          </div>
        </div>
        {uploading && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-[var(--radius-ui)] bg-[var(--bg-2)]">
            <div className="h-full rounded-[var(--radius-ui)] bg-[var(--accent)] transition-all" style={{ width: `${progress}%` }} />
          </div>
        )}
      </button>
      {value && (
        <p className="truncate text-xs text-muted-foreground">
          Bound hash <span className="font-mono">{value}</span>
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
