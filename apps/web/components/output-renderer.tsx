"use client";

// Per-field output card: a label header + the GENERIC renderer + a download
// button. The actual type→view logic lives once in `GenericOutput`
// (components/generic-output.tsx) and is reused by the run page, the approval
// surface, and the worker example-result (DRY). This wrapper only adds the
// field label and the type-appropriate download affordance.
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { GenericOutput } from "@/components/generic-output";
import type { OutputField } from "@/lib/types";
import { stripCitationTokens } from "@/lib/strip-citations";

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function DownloadButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
      onClick={onClick}
      title={`Download as ${label}`}
    >
      <Download className="w-3 h-3" />
      {label}
    </Button>
  );
}

const DOWNLOAD_SPEC: Record<string, { ext: string; mime: string; label: string }> = {
  markdown: { ext: "md", mime: "text/markdown", label: ".md" },
  json: { ext: "json", mime: "application/json", label: ".json" },
  csv: { ext: "csv", mime: "text/csv", label: ".csv" },
  text: { ext: "txt", mime: "text/plain", label: ".txt" },
};

export function OutputRenderer({ field, runId }: { field: OutputField; runId?: string }) {
  const { type, value, label, name } = field;
  const safeRunId = runId || "run";
  const baseFilename = `${safeRunId}-${name}`;

  if (value == null || value === "") {
    return (
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">{label || name}</p>
        <p className="text-sm text-muted-foreground">No output.</p>
      </div>
    );
  }

  const spec = DOWNLOAD_SPEC[type];
  const downloadContent =
    type === "json"
      ? (() => {
          try {
            const parsed = typeof value === "string" ? JSON.parse(value) : value;
            return JSON.stringify(parsed, null, 2);
          } catch {
            return String(value);
          }
        })()
      : stripCitationTokens(String(value));

  // The generic viewer surface gets a subtle card frame for markdown/text so the
  // content reads as a discrete block within the Output tab.
  const framed = type === "markdown" || type === "text";

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-2">{label || name}</p>
      <div className="space-y-2">
        <GenericOutput
          type={type}
          value={value}
          className={framed ? "bg-muted/30 p-4 rounded-[var(--radius-ui)]" : undefined}
        />
        {spec && type !== "file" && (
          <DownloadButton
            label={spec.label}
            onClick={() => downloadBlob(downloadContent, `${baseFilename}.${spec.ext}`, spec.mime)}
          />
        )}
      </div>
    </div>
  );
}
