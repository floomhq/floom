"use client";

import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";

import { api, getActiveWorkspaceId, setActiveWorkspaceId } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { LocalWorkspace } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type WorkspaceState = {
  workspaces: LocalWorkspace[];
  activeId: string;
};

function shortInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.slice(0, 2).toUpperCase();
}

export function WorkspaceSwitcher() {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.workspace
      .list()
      .then((data) => {
        if (cancelled) return;
        const browserActiveId = getActiveWorkspaceId();
        const activeId =
          browserActiveId && data.workspaces?.some((workspace) => workspace.id === browserActiveId)
            ? browserActiveId
            : data.active_id || "local-default";
        setState({
          workspaces: data.workspaces ?? [],
          activeId,
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || "Failed to load workspaces");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSwitch(workspaceId: string) {
    if (state && state.activeId === workspaceId) return;
    setSwitchingTo(workspaceId);
    try {
      await api.workspace.select(workspaceId);
      setActiveWorkspaceId(workspaceId);
      window.location.reload();
    } catch (err) {
      setError((err as Error).message || "Failed to switch workspace");
      setSwitchingTo(null);
    }
  }

  async function handleCreate() {
    const name = createName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await api.workspace.create(name);
      await api.workspace.select(created.id);
      setActiveWorkspaceId(created.id);
      window.location.reload();
    } catch (err) {
      setError((err as Error).message || "Failed to create workspace");
      setCreating(false);
    }
  }

  if (!state) {
    return (
      <div className="px-3 pb-2">
        <div
          className="flex h-10 items-center gap-2 rounded-md border border-line bg-transparent px-2.5 text-sm text-[var(--ink-mute)]"
          aria-label="Loading workspaces"
        >
          <div className="size-6 shrink-0 rounded-md bg-muted" />
          <div className="h-3 w-20 rounded bg-muted" />
        </div>
      </div>
    );
  }

  const active =
    state.workspaces.find((w) => w.id === state.activeId) ??
    state.workspaces[0] ??
    null;

  if (!active) {
    return (
      <div className="px-3 pb-2 text-xs text-[var(--ink-mute)]">
        {error ?? "No workspaces yet"}
      </div>
    );
  }

  return (
    <div className="px-3 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex h-10 w-full items-center gap-2 rounded-md border border-line bg-transparent px-2.5 text-sm font-medium text-ink transition-colors duration-150",
            "hover:bg-[color-mix(in_srgb,var(--paper)_62%,transparent)]"
          )}
          aria-label="Switch workspace"
        >
          <div className="size-6 shrink-0 rounded-md bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] text-[var(--accent)] grid place-items-center text-[10px] font-semibold uppercase tracking-wide">
            {shortInitial(active.name)}
          </div>
          <span className="flex-1 truncate text-left">{active.name}</span>
          <ChevronsUpDown className="size-4 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          className="w-56"
          sideOffset={6}
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-[var(--ink-mute)]">
              Workspaces
            </DropdownMenuLabel>
            {state.workspaces.map((w) => {
              const isActive = w.id === state.activeId;
              const isLoading = switchingTo === w.id;
              return (
                <DropdownMenuItem
                  key={w.id}
                  onClick={() => handleSwitch(w.id)}
                  className="flex items-center gap-2 focus:bg-[var(--active-nav-bg)] focus:text-ink"
                  disabled={isLoading}
                >
                  <div className="size-5 shrink-0 rounded-md bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)] grid place-items-center text-[9px] font-semibold uppercase">
                    {shortInitial(w.name)}
                  </div>
                  <span className="flex-1 truncate">{w.name}</span>
                  {isActive ? <Check className="size-4 opacity-80" /> : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setCreateName("");
              setCreateOpen(true);
            }}
            className="flex items-center gap-2 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
          >
            <Plus className="size-4" />
            New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              Workspaces keep workers, runs, connections, secrets, and brain packs
              isolated on this local Workeros instance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="e.g. Side project"
              maxLength={80}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter" && createName.trim() && !creating) {
                  event.preventDefault();
                  handleCreate();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              type="button"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleCreate}
              disabled={!createName.trim() || creating}
            >
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
