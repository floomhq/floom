"use client";

import { History, RotateCcw, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { VersionSummary } from "@/lib/types";

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface VersionHistoryMenuProps {
  versions: VersionSummary[];
  loading: boolean;
  restoringId: string | null;
  onOpen: () => void;
  onRestore: (v: VersionSummary) => void;
}

export function VersionHistoryMenu({
  versions,
  loading,
  restoringId,
  onOpen,
  onRestore,
}: VersionHistoryMenuProps) {
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) onOpen(); }}>
      <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground hover:bg-[var(--bg-2)] transition-colors">
        <History className="w-3.5 h-3.5" />
        History
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading versions…
          </div>
        ) : versions.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">No saved versions.</div>
        ) : (
          <>
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Version history</div>
            <DropdownMenuSeparator />
            {versions.map((v) => (
              <DropdownMenuItem
                key={v.id}
                disabled={restoringId === v.id}
                onClick={() => onRestore(v)}
                className="flex items-center justify-between gap-2 cursor-pointer"
              >
                <span className="text-sm">v{v.version_number}</span>
                <span className="text-xs text-muted-foreground">{formatRelative(v.created_at)}</span>
                {restoringId === v.id
                  ? <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                  : <RotateCcw className="w-3 h-3 text-muted-foreground shrink-0" />
                }
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
