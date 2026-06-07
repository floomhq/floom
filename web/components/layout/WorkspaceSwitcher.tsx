"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Copy, Download, FolderOpen, Link, Plus, Upload } from "lucide-react";

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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Cloud overlay: the WorkspaceSwitcher is a Cloud-only feature (the engine OSS
// build is single-workspace). It MUST NOT depend on the synced engine
// lib/api.ts or lib/types.ts — those are regenerated from the engine on every
// build and do not carry a `workspaces` namespace or `Workspace` type. So this
// component is fully self-contained: it talks to the same proxy via the env
// seam (NEXT_PUBLIC_API_PROXY_BASE) the engine api.ts uses, and defines its own
// Workspace shape. Keeping it decoupled is what lets the engine tree be a clean
// generated drop-in (no fork).
interface Workspace {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
}

const PROXY_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";
const ACTIVE_WORKSPACE_STORAGE_KEY = "workeros.activeWorkspaceId";

function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  return value || null;
}

function workspaceHeaders(workspaceId = getActiveWorkspaceId()): Headers {
  const headers = new Headers();
  if (workspaceId) {
    headers.set("x-workeros-workspace", workspaceId);
  }
  return headers;
}

function setActiveWorkspaceId(workspaceId: string | null) {
  if (typeof window === "undefined") return;
  if (!workspaceId) {
    window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  } else {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
  }
}

async function proxyJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = workspaceHeaders();
  for (const [key, value] of new Headers(init?.headers)) {
    headers.set(key, value);
  }
  headers.set("Content-Type", "application/json");
  const res = await fetch(`${PROXY_BASE}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string };
      detail = body.detail || JSON.stringify(body);
    } catch {
      detail = res.statusText || `HTTP ${res.status}`;
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

const workspacesApi = {
  list: () =>
    proxyJson<{ workspaces: Workspace[]; active_id: string | null }>("/workspaces"),
  create: (name: string) =>
    proxyJson<Workspace>("/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  select: (id: string) =>
    proxyJson<Workspace>(`/workspaces/${encodeURIComponent(id)}/select`, {
      method: "POST",
    }),
};

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
  const [exporting, setExporting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    workspacesApi
      .list()
      .then((data) => {
        if (cancelled) return;
        const browserActiveId = getActiveWorkspaceId();
        const activeId =
          browserActiveId && data.workspaces?.some((workspace) => workspace.id === browserActiveId)
            ? browserActiveId
            : data.active_id ?? null;
        if (activeId !== browserActiveId) {
          setActiveWorkspaceId(activeId);
        }
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
    if (state && state.activeId === workspaceId) {
      return;
    }
    setSwitchingTo(workspaceId);
    try {
      await workspacesApi.select(workspaceId);
      setActiveWorkspaceId(workspaceId);
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
      const created = await workspacesApi.create(name);
      await workspacesApi.select(created.id);
      setActiveWorkspaceId(created.id);
      window.location.reload();
    } catch (err) {
      setError((err as Error).message || "Failed to create workspace");
      setCreating(false);
    }
  }

  async function handleExportWorkspace(workspace: Workspace) {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(`${PROXY_BASE}/workspace/export`, {
        headers: workspaceHeaders(workspace.id),
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${workspace.name.trim() || "workspace"}-template.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (err) {
      setError((err as Error).message || "Failed to export workspace");
    } finally {
      setExporting(false);
    }
  }

  async function handleDuplicateWorkspace(workspace: Workspace) {
    setDuplicating(true);
    setError(null);
    try {
      const exportRes = await fetch(`${PROXY_BASE}/workspace/export`, {
        headers: workspaceHeaders(workspace.id),
      });
      if (!exportRes.ok) throw new Error(`Export failed (${exportRes.status})`);
      const template = await exportRes.blob();
      const created = await workspacesApi.create(`Copy of ${workspace.name}`);
      const form = new FormData();
      form.append(
        "bundle",
        new File([template], "workspace-template.zip", { type: "application/zip" })
      );
      const importRes = await fetch(`${PROXY_BASE}/workspace/import`, {
        method: "POST",
        headers: workspaceHeaders(created.id),
        body: form,
      });
      if (!importRes.ok) {
        let detail = "";
        try {
          const body = (await importRes.json()) as { detail?: string };
          detail = body.detail || JSON.stringify(body);
        } catch {
          detail = importRes.statusText || `HTTP ${importRes.status}`;
        }
        throw new Error(detail);
      }
      await workspacesApi.select(created.id);
      setActiveWorkspaceId(created.id);
      window.location.reload();
    } catch (err) {
      setError((err as Error).message || "Failed to duplicate workspace");
      setDuplicating(false);
    }
  }

  async function handleCreateShareLink(workspace: Workspace) {
    setSharing(true);
    setShareCopied(false);
    setError(null);
    try {
      const share = await proxyJson<{ url?: string }>(
        `/workspaces/${encodeURIComponent(workspace.id)}/share-links`,
        {
          method: "POST",
          body: JSON.stringify({ expires_in_days: 7 }),
        }
      );
      if (!share.url) throw new Error("Share link missing from response");
      await navigator.clipboard.writeText(share.url);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 3_000);
    } catch (err) {
      setError((err as Error).message || "Failed to create share link");
    } finally {
      setSharing(false);
    }
  }

  async function handleImportFromFile(file: File) {
    setImporting(true);
    setError(null);
    try {
      const created = await workspacesApi.create(`Imported workspace`);
      const form = new FormData();
      form.append(
        "bundle",
        new File([file], "workspace-template.zip", { type: "application/zip" })
      );
      const importRes = await fetch(`${PROXY_BASE}/workspace/import`, {
        method: "POST",
        headers: workspaceHeaders(created.id),
        body: form,
      });
      if (!importRes.ok) {
        let detail = "";
        try {
          const body = (await importRes.json()) as { detail?: string };
          detail = body.detail || JSON.stringify(body);
        } catch {
          detail = importRes.statusText || `HTTP ${importRes.status}`;
        }
        throw new Error(detail);
      }
      await workspacesApi.select(created.id);
      setActiveWorkspaceId(created.id);
      window.location.reload();
    } catch (err) {
      setError((err as Error).message || "Failed to import workspace");
      setImporting(false);
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className="flex items-center gap-2 text-[var(--ink-soft)]"
            >
              <FolderOpen className="size-4" />
              Workspace actions
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                onClick={() => handleDuplicateWorkspace(active)}
                className="flex items-center gap-2"
                disabled={duplicating || exporting || sharing || importing}
              >
                <Copy className="size-4" />
                {duplicating ? "Copying…" : "Make a local copy"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleExportWorkspace(active)}
                className="flex items-center gap-2"
                disabled={duplicating || exporting || sharing || importing}
              >
                <Download className="size-4" />
                {exporting ? "Downloading…" : "Download copy"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleCreateShareLink(active)}
                className="flex items-center gap-2"
                disabled={duplicating || exporting || sharing || importing}
              >
                <Link className="size-4" />
                {sharing ? "Copying link…" : shareCopied ? "Link copied" : "Copy setup link"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2"
                disabled={duplicating || exporting || sharing || importing}
              >
                <Upload className="size-4" />
                {importing ? "Importing…" : "Import from file…"}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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

      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        className="sr-only"
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImportFromFile(file);
          e.target.value = "";
        }}
      />

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
