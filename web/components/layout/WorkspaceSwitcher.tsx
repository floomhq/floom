"use client";

import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";

import { api } from "@/lib/api";
import type { Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";
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

interface WorkspaceState {
  workspaces: Workspace[];
  activeId: string | null;
}

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
    api.workspaces
      .list()
      .then((data) => {
        if (cancelled) return;
        setState({
          workspaces: data.workspaces ?? [],
          activeId: data.active_id ?? null,
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
    if (state && state.activeId === workspaceId) {
      return;
    }
    setSwitchingTo(workspaceId);
    try {
      await api.workspaces.select(workspaceId);
      // Everything in the dashboard is workspace-scoped, so the simplest
      // correct UX is a full reload — no chance of stale React state
      // (workers/runs/connections/secrets) leaking across workspaces.
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
      const created = await api.workspaces.create(name);
      await api.workspaces.select(created.id);
      window.location.reload();
    } catch (err) {
      setError((err as Error).message || "Failed to create workspace");
      setCreating(false);
    }
  }

  // Render-state guards: while loading we show a placeholder so the
  // sidebar doesn't jump when data arrives.
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
                  // base-ui's Menu.Item exposes onClick, NOT onSelect (that
                  // was the Radix API). The previous onSelect prop was
                  // silently dropped, so clicking a workspace did nothing.
                  onClick={() => handleSwitch(w.id)}
                  className="flex items-center gap-2"
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
            className="flex items-center gap-2 text-[var(--ink-soft)]"
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
              Workspaces keep workers, runs, connections, and secrets
              isolated. You can create as many as you want.
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
              {creating ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error ? (
        <div className="mt-1 text-[10px] text-red-500" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
