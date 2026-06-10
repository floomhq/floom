"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronsUpDown, Copy, Download, Link2, Pencil, Plus, Settings2, Trash2, Upload, Users } from "lucide-react";
import { toast } from "sonner";

import { api, getActiveWorkspaceId, setActiveWorkspaceId } from "@/lib/api";
import { cn } from "@/lib/utils";
import { companyLogoUrl, prefillWorkspaceName } from "@/lib/workspace/company-logo";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  const [createCompany, setCreateCompany] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [sharingLink, setSharingLink] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

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

  // #791: rename the active workspace.
  async function handleRename() {
    const name = renameName.trim();
    if (!name || !state) return;
    setRenaming(true);
    try {
      const updated = await api.workspace.rename(state.activeId, name);
      setState({
        ...state,
        workspaces: state.workspaces.map((w) =>
          w.id === state.activeId ? { ...w, name: updated.name } : w
        ),
      });
      setRenameOpen(false);
    } catch (err) {
      setError((err as Error).message || "Failed to rename workspace");
    } finally {
      setRenaming(false);
    }
  }

  // #805: delete the active workspace, then fall back to the default.
  async function handleDelete() {
    if (!state || state.activeId === "local-default") return;
    setDeleting(true);
    try {
      await api.workspace.remove(state.activeId);
      await api.workspace.select("local-default");
      setActiveWorkspaceId("local-default");
      window.location.reload();
    } catch (err) {
      setError((err as Error).message || "Failed to delete workspace");
      setDeleting(false);
    }
  }

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      const { blob, filename } = await api.workspace.exportTemplate();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Workspace template exported");
    } catch (err) {
      toast.error((err as Error).message || "Failed to export template");
    } finally {
      setExporting(false);
    }
  }

  async function handleImportFile(file: File) {
    setImporting(true);
    try {
      const result = await api.workspace.importTemplate(file);
      const imported = result.workers_imported.length + result.contexts_imported.length;
      toast.success(
        `Imported ${imported} item${imported === 1 ? "" : "s"}${
          result.skipped.length ? ` · ${result.skipped.length} skipped` : ""
        }`
      );
      window.location.reload();
    } catch (err) {
      toast.error((err as Error).message || "Failed to import template");
    } finally {
      setImporting(false);
    }
  }

  async function handleDuplicate() {
    if (duplicating || !state) return;
    setDuplicating(true);
    try {
      const created = await api.workspace.duplicate(state.activeId);
      await api.workspace.select(created.id);
      setActiveWorkspaceId(created.id);
      toast.success(`Duplicated to “${created.name}”`);
      window.location.reload();
    } catch (err) {
      toast.error((err as Error).message || "Failed to duplicate workspace");
      setDuplicating(false);
    }
  }

  async function handleShareLink() {
    if (sharingLink) return;
    setSharingLink(true);
    try {
      const { url } = await api.workspace.shareLink();
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        copied = false;
      }
      toast.success(
        copied ? "Template link copied to clipboard" : "Template link ready",
        { description: copied ? undefined : url }
      );
    } catch (err) {
      toast.error((err as Error).message || "Failed to create template link");
    } finally {
      setSharingLink(false);
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
        {/* V9 (Federico 2026-06-02): "this can also be cleaner." The popover is
            split into two clear sections — the workspace LIST (active row
            carries the checkmark) and the ACTIONS group below a divider — with
            consistent spacing. The active workspace name is shown only here in
            the list (the trigger above is the closed-state control), so there's
            no redundant repetition inside the menu. */}
        <DropdownMenuContent
          align="start"
          side="bottom"
          className="w-56 p-1"
          sideOffset={6}
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--ink-mute)]">
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
          <DropdownMenuSeparator className="-mx-1 my-1" />
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={() => {
                setCreateName("");
                setCreateCompany("");
                setNameTouched(false);
                setCreateOpen(true);
              }}
              className="flex items-center gap-2 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
            >
              <Plus className="size-4" />
              New workspace
            </DropdownMenuItem>
            {/* #791: rename the active workspace. */}
            <DropdownMenuItem
              closeOnClick={false}
              onClick={() => {
                setRenameName(
                  state.workspaces.find((w) => w.id === state.activeId)?.name ?? ""
                );
                setRenameOpen(true);
              }}
              className="flex items-center gap-2 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
            >
              <Pencil className="size-4" />
              Rename workspace
            </DropdownMenuItem>
            {/* #805: delete is offered only for non-default workspaces. */}
            {state.activeId !== "local-default" && (
              <DropdownMenuItem
                closeOnClick={false}
                onClick={() => setDeleteOpen(true)}
                className="flex items-center gap-2 text-[var(--warning)] focus:bg-[var(--active-nav-bg)] focus:text-[var(--warning)]"
              >
                <Trash2 className="size-4" />
                Delete workspace
              </DropdownMenuItem>
            )}
            {/* G10 (Federico 2026-06-03): Members lives in the workspace cluster,
                peer to "New workspace". One model both products: on the OS it
                shows you as Owner; Cloud shows real members. */}
            <DropdownMenuItem
              render={<Link href="/members" />}
              className="flex items-center gap-2 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
            >
              <Users className="size-4" />
              Members
            </DropdownMenuItem>
            {/* G1 (Federico 2026-06-03, img #91/#94): the four template actions
                are collapsed into ONE "Workspace actions" row that reveals them
                on hover — peer to "New workspace" — instead of a flat list. */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="flex items-center gap-2 text-[var(--ink-soft)] data-popup-open:bg-[var(--active-nav-bg)] data-popup-open:text-ink">
                <Settings2 className="size-4" />
                Workspace actions
              </DropdownMenuSubTrigger>
              {/* M34/M35: clarified labels. Export = download a zip anyone can
                  import; Share template link = a signed URL to that zip (no
                  secrets, no connections); Duplicate = live copy in this
                  instance with agents + instructions, connections & secrets
                  NOT copied (intentional: they must be reconnected). */}
              <DropdownMenuSubContent className="w-64 p-1">
                <DropdownMenuItem
                  closeOnClick={false}
                  disabled={exporting}
                  onClick={() => void handleExport()}
                  className="flex flex-col items-start gap-0 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
                >
                  <div className="flex items-center gap-2">
                    <Download className="size-4 shrink-0" />
                    <span>{exporting ? "Exporting…" : "Export workspace"}</span>
                  </div>
                  <span className="ml-6 text-[10px] text-[var(--ink-mute)] leading-tight">
                    Download a zip of agents + instructions (no secrets)
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  closeOnClick={false}
                  disabled={importing}
                  onClick={() => importInputRef.current?.click()}
                  className="flex flex-col items-start gap-0 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
                >
                  <div className="flex items-center gap-2">
                    <Upload className="size-4 shrink-0" />
                    <span>{importing ? "Importing…" : "Import workspace…"}</span>
                  </div>
                  <span className="ml-6 text-[10px] text-[var(--ink-mute)] leading-tight">
                    Restore from an exported zip
                  </span>
                </DropdownMenuItem>
                {/* W9b: Duplicate mints a "<name> (copy)" sibling; Share copies a
                    signed login-free download link (no secret values). */}
                <DropdownMenuItem
                  closeOnClick={false}
                  disabled={duplicating}
                  onClick={() => void handleDuplicate()}
                  className="flex flex-col items-start gap-0 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
                >
                  <div className="flex items-center gap-2">
                    <Copy className="size-4 shrink-0" />
                    <span>{duplicating ? "Duplicating…" : "Duplicate workspace"}</span>
                  </div>
                  <span className="ml-6 text-[10px] text-[var(--ink-mute)] leading-tight">
                    Copies agents + instructions. Connections &amp; secrets are not copied — reconnect after.
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  closeOnClick={false}
                  disabled={sharingLink}
                  onClick={() => void handleShareLink()}
                  className="flex flex-col items-start gap-0 text-[var(--ink-soft)] focus:bg-[var(--active-nav-bg)] focus:text-ink"
                >
                  <div className="flex items-center gap-2">
                    <Link2 className="size-4 shrink-0" />
                    <span>{sharingLink ? "Creating link…" : "Share as template link"}</span>
                  </div>
                  <span className="ml-6 text-[10px] text-[var(--ink-mute)] leading-tight">
                    Shareable link to the exported zip — no secrets included
                  </span>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={importInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleImportFile(file);
          event.target.value = "";
        }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              Workspaces keep workers, runs, connections, secrets, and brain folders
              isolated on this local WorkerOS instance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {/* §5a2: ONE company field — derives a logo + prefills the name. */}
            <div className="space-y-2">
              <Label htmlFor="workspace-company">Company</Label>
              <div className="flex items-center gap-2.5">
                <div className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-md bg-[var(--bg-2)]">
                  {companyLogoUrl(createCompany) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={companyLogoUrl(createCompany) as string}
                      alt=""
                      className="size-5"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                      }}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {(createName || createCompany || "?").slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </div>
                <Input
                  id="workspace-company"
                  value={createCompany}
                  onChange={(event) => {
                    const v = event.target.value;
                    setCreateCompany(v);
                    if (!nameTouched) setCreateName(prefillWorkspaceName(v));
                  }}
                  placeholder="e.g. Acme or acme.com"
                  maxLength={80}
                  autoFocus
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="workspace-name">Workspace name</Label>
              <Input
                id="workspace-name"
                value={createName}
                onChange={(event) => {
                  setNameTouched(true);
                  setCreateName(event.target.value);
                }}
                placeholder="e.g. Acme"
                maxLength={80}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && createName.trim() && !creating) {
                    event.preventDefault();
                    handleCreate();
                  }
                }}
              />
            </div>
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

      {/* #791: rename the active workspace. */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="workspace-rename">Name</Label>
            <Input
              id="workspace-rename"
              value={renameName}
              onChange={(event) => setRenameName(event.target.value)}
              maxLength={80}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter" && renameName.trim() && !renaming) {
                  event.preventDefault();
                  handleRename();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => setRenameOpen(false)} disabled={renaming}>
              Cancel
            </Button>
            <Button type="button" onClick={handleRename} disabled={!renameName.trim() || renaming}>
              {renaming ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* #805: confirm before deleting a workspace (in-house modal, never confirm()). */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete workspace?</DialogTitle>
            <DialogDescription>
              This removes the workspace entry. Workers and knowledge live in a shared pool
              on this instance and are not deleted. You&apos;ll switch back to the default workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              style={{ background: "var(--warning)", color: "#fff" }}
            >
              {deleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
