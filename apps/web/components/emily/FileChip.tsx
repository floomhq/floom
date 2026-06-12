import { FileText, X } from "lucide-react";
import type { AttachedFile } from "@/lib/emily-chat-types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon({ type }: { type: string }) {
  if (type.startsWith("image/")) {
    return (
      <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wide">IMG</span>
    );
  }
  return <FileText className="size-3 text-muted-foreground" />;
}

export function FileChip({
  file,
  onRemove,
}: {
  file: AttachedFile;
  onRemove?: () => void;
}) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-muted/60 pl-2.5 pr-1.5 py-1 text-xs max-w-[200px]">
      <FileIcon type={file.type} />
      <span className="truncate flex-1 min-w-0 text-foreground/80">{file.name}</span>
      <span className="text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-[var(--radius-pill)] p-0.5 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${file.name}`}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

export { formatBytes };
