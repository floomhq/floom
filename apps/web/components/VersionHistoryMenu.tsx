"use client";

import { History, RotateCcw } from "lucide-react";

import type { VersionSummary } from "@/lib/types";
import { formatRelative } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function commitMessageBadge(message: string) {
  const isRollback = message.startsWith("rollback:");
  const isAi = message.includes("(ai)");
  return (
    <span
      className={cn(
        "inline-flex max-w-[140px] items-center truncate rounded-[var(--radius-pill)] [border:var(--bd-pill)] px-1.5 py-0.5 text-[10px] font-medium",
        isRollback
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 group-focus/dropdown-menu-item:bg-amber-400/30"
          : isAi
            ? "bg-violet-500/10 text-violet-700 dark:text-violet-400 group-focus/dropdown-menu-item:bg-violet-400/30"
            : "bg-muted text-muted-foreground group-focus/dropdown-menu-item:bg-white/20"
      )}
      title={message}
    >
      {message}
    </span>
  );
}

// A single, consistent "Versions ▾" dropdown affordance for git-backed
// version history. Used for workspace instructions (/assistant), per-file
// brain revisions (/contexts), and worker config versions (/workers/<id>).
// Every edit is a git commit — each entry shows the SHA, message, and author.
export function VersionHistoryMenu({
  versions,
  loading,
  canRestore = true,
  restoringId,
  onRestore,
  onOpen,
  buttonClassName,
}: {
  versions: VersionSummary[];
  loading: boolean;
  canRestore?: boolean;
  restoringId?: string | null;
  onRestore: (version: VersionSummary) => void;
  onOpen?: () => void;
  buttonClassName?: string;
}) {
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <DropdownMenuTrigger
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), buttonClassName)}
      >
        <History className="size-3.5" />
        Versions
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-80 p-1">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Git history
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="-mx-1 my-1" />
          {loading ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
          ) : versions.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No commits yet. Every save creates a git commit.
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {versions.map((v, idx) => {
              const isCurrent = idx === 0;
              const isRestoring = restoringId === v.id;
              return (
                <DropdownMenuItem
                  key={v.id}
                  closeOnClick={false}
                  disabled={isCurrent || !canRestore || isRestoring}
                  onClick={() => {
                    if (isCurrent || !canRestore || isRestoring) return;
                    onRestore(v);
                  }}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                        {v.sha}
                      </span>
                      {commitMessageBadge(v.message)}
                      {isCurrent && (
                        <span className="text-[10px] font-medium text-muted-foreground shrink-0">
                          (current)
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {v.author} · {formatRelative(v.timestamp)}
                    </span>
                  </span>
                  {!isCurrent && canRestore && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-foreground">
                      <RotateCcw className="size-3" />
                      {isRestoring ? "Restoring…" : "Restore"}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
            </div>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
