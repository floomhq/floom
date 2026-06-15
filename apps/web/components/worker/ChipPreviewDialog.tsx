"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Folder, Loader2, Zap } from "lucide-react";
import { api } from "@/lib/api";
import type { CatalogToolItem, ContextDetail, ContextFileItem } from "@/lib/types";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { InlineFileOpen, type InlineFile } from "@/components/file-viewer/InlineFileOpen";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// #1303 — read-only preview popup opened from a brain-folder chip or a
// tool/integration chip in the worker detail. Brain mode lists the folder's
// files (clickable inline preview); integration mode lists the connection's
// available actions. Lazy-fetched on open; cached across opens.

const _toolsCache = new Map<string, CatalogToolItem[]>();
const _contextCache = new Map<string, ContextDetail>();

export type ChipPreviewTarget =
  | { kind: "brain"; name: string }
  | { kind: "integration"; app: string };

function fileToInline(name: string, f: ContextFileItem): InlineFile {
  return {
    id: f.path,
    name: f.path,
    url: api.contexts.fileUrl(name, f.path),
    sizeBytes: f.size,
    binary: f.is_binary,
    tags: f.tags,
  };
}

function BrainPreview({ name }: { name: string }) {
  const [detail, setDetail] = useState<ContextDetail | null>(_contextCache.get(name) ?? null);
  const [loading, setLoading] = useState(!_contextCache.has(name));

  useEffect(() => {
    if (_contextCache.has(name)) {
      setDetail(_contextCache.get(name)!);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api.contexts
      .get(name)
      .then((d) => {
        _contextCache.set(name, d);
        if (alive) setDetail(d);
      })
      .catch(() => alive && setDetail(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [name]);

  const files: InlineFile[] = useMemo(
    () => (detail?.files ?? []).filter((f) => !f.deleted).map((f) => fileToInline(name, f)),
    [detail, name],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading folder…
      </div>
    );
  }

  return (
    <InlineFileOpen
      files={files}
      rootLabel={name}
      emptyLabel="This folder has no files yet."
      loadText={(file) => api.contexts.readTextFile(name, file.id)}
      loadSqlite={(file, table) => api.contexts.sqlite(name, file.id, table)}
    />
  );
}

function IntegrationPreview({ app }: { app: string }) {
  const slug = app.toLowerCase();
  const [tools, setTools] = useState<CatalogToolItem[] | null>(_toolsCache.get(slug) ?? null);
  const [loading, setLoading] = useState(!_toolsCache.has(slug));

  useEffect(() => {
    if (_toolsCache.has(slug)) {
      setTools(_toolsCache.get(slug)!);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api.integrations
      .catalogTools(slug)
      .then((data) => {
        _toolsCache.set(slug, data);
        if (alive) setTools(data);
      })
      .catch(() => alive && setTools([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [slug]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading actions…
      </div>
    );
  }

  if (!tools || tools.length === 0) {
    return <p className="py-6 text-center text-xs text-muted-foreground">No action details available.</p>;
  }

  return (
    <ul className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
      {tools.map((tool) => (
        <li key={tool.name} className="flex items-start gap-2.5">
          <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">{tool.name}</p>
            {tool.description ? (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{tool.description}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ChipPreviewDialog({
  target,
  onOpenChange,
}: {
  target: ChipPreviewTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = target !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-full max-w-lg flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex-row items-center gap-3 [border-bottom:var(--bd-div)] px-4 py-3"> {/* ds-allow-border */}
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-card)]"> {/* ds-allow-border ds-allow-round */}
            {target?.kind === "integration" ? (
              <BrandLogo icon={target.app} className="size-5" />
            ) : (
              <Folder className="size-4 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0">
            <DialogTitle className="truncate text-sm font-semibold" style={{ textTransform: target?.kind === "integration" ? "capitalize" : "none" }}>
              {target?.kind === "integration" ? target.app : target?.name}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {target?.kind === "integration" ? "Actions this tool can run" : "Files in this brain folder"}
            </DialogDescription>
          </div>
          {target?.kind === "integration" && (
            <Link
              href="/connections"
              className="c-vpill ml-auto shrink-0"
              style={{ padding: "4px 9px", textDecoration: "none" }}
            >
              Open
            </Link>
          )}
          {target?.kind === "brain" && (
            <Link
              href={`/contexts?pack=${encodeURIComponent(target.name)}`}
              className="c-vpill ml-auto shrink-0"
              style={{ padding: "4px 9px", textDecoration: "none" }}
            >
              Open
            </Link>
          )}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {target?.kind === "brain" && <BrainPreview name={target.name} />}
          {target?.kind === "integration" && <IntegrationPreview app={target.app} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
