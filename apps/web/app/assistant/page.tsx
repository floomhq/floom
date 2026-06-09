"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Edit3, RotateCcw, Save, X } from "lucide-react";

import { api } from "@/lib/api";
import type { VersionSummary, WorkspaceAgentInfo } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { VersionHistoryMenu } from "@/components/VersionHistoryMenu";
import { AssetVisibilityControl } from "@/components/AssetVisibilityControl";
import { EmilyAvatar } from "@/components/emily/EmilyAvatar";

type TabKey = "base" | "instructions" | "prompt";

const TABS: TabKey[] = ["base", "instructions", "prompt"];

function validTab(value: string): value is TabKey {
  return TABS.includes(value as TabKey);
}

// Inline "Versions" dropdown reused by both editable layers (base + workspace).
// Lazily loads the version list when opened and rolls back in place.
function HistoryMenu({
  loadVersions,
  rollback,
  onRollback,
  refreshKey,
  confirmLabel,
}: {
  loadVersions: () => Promise<VersionSummary[]>;
  rollback: (versionId: string) => Promise<string>;
  onRollback: (content: string) => void;
  refreshKey: number;
  confirmLabel: string;
}) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<VersionSummary | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setVersions(await loadVersions());
    } catch {
      setVersions([]);
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [loadVersions]);

  // Re-fetch when a save/rollback bumps the key, but only if already opened
  // once (avoids fetching for users who never open the dropdown).
  useEffect(() => {
    if (loadedOnce) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  async function doRollback() {
    if (!pendingRestore) return;
    const v = pendingRestore;
    setPendingRestore(null);
    setRollingBack(v.id);
    try {
      const content = await rollback(v.id);
      onRollback(content);
      await refresh();
      toast.success(`Rolled back to version ${v.sha}`);
    } catch (e: unknown) {
      toast.error(`Rollback failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setRollingBack(null);
    }
  }

  return (
    <>
      <VersionHistoryMenu
        versions={versions}
        loading={loading && !loadedOnce}
        restoringId={rollingBack}
        onOpen={() => {
          if (!loadedOnce) void refresh();
        }}
        onRestore={(v) => setPendingRestore(v)}
      />

      <Dialog
        open={!!pendingRestore}
        onOpenChange={(open) => { if (!open) setPendingRestore(null); }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Restore version {pendingRestore?.sha}?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {confirmLabel} The current version is saved automatically before restoring.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRestore(null)}>
              Cancel
            </Button>
            <Button onClick={() => void doRollback()}>
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function AssistantPage() {
  const initial =
    typeof window !== "undefined" && validTab(window.location.hash.replace(/^#/, ""))
      ? (window.location.hash.replace(/^#/, "") as TabKey)
      : "base";
  const [tab, setTab] = useState<TabKey>(initial);
  const [agent, setAgent] = useState<WorkspaceAgentInfo | null>(null);

  // Layer 1: base instructions (built-in Emily persona, applies to ALL conversations).
  const [base, setBase] = useState("");
  const [originalBase, setOriginalBase] = useState("");
  const [baseIsCustom, setBaseIsCustom] = useState(false);
  const [editingBase, setEditingBase] = useState(false);
  const [savingBase, setSavingBase] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);

  // Layer 2: workspace instructions (per-workspace, layered after base).
  const [instructions, setInstructions] = useState("");
  const [originalInstructions, setOriginalInstructions] = useState("");
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [saving, setSaving] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [versionsKey, setVersionsKey] = useState(0);
  const [baseVersionsKey, setBaseVersionsKey] = useState(0);

  const dirty = instructions !== originalInstructions;
  const baseDirty = base !== originalBase;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentRes, baseRes, instructionsRes] = await Promise.all([
        api.system.workspaceAgent(),
        api.system.workspaceBasePersona(),
        api.system.workspaceInstructions(),
      ]);
      setAgent(agentRes);
      setBase(baseRes.content);
      setOriginalBase(baseRes.content);
      setBaseIsCustom(baseRes.is_custom);
      setInstructions(instructionsRes);
      setOriginalInstructions(instructionsRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspace agent");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function sync() {
      const next = window.location.hash.replace(/^#/, "");
      if (validTab(next)) setTab(next);
    }
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function changeTab(value: string) {
    if (!validTab(value)) return;
    setTab(value);
    window.history.replaceState(null, "", `/assistant#${value}`);
  }

  async function saveBase() {
    if (!base.trim()) {
      toast.error("Base instructions cannot be empty");
      return;
    }
    setSavingBase(true);
    try {
      await api.system.updateWorkspaceBasePersona(base);
      setOriginalBase(base);
      setBaseIsCustom(true);
      setEditingBase(false);
      toast.success("Base instructions saved");
      setBaseVersionsKey((k) => k + 1);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save base instructions");
    } finally {
      setSavingBase(false);
    }
  }

  async function resetBase() {
    setResetting(true);
    try {
      await api.system.resetWorkspaceBasePersona();
      setResetConfirm(false);
      setEditingBase(false);
      toast.success("Base instructions reset to the built-in default");
      setBaseVersionsKey((k) => k + 1);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset base instructions");
    } finally {
      setResetting(false);
    }
  }

  function handleBaseRollback(content: string) {
    setBase(content);
    setOriginalBase(content);
    setBaseIsCustom(true);
    setEditingBase(false);
    setBaseVersionsKey((k) => k + 1);
  }

  async function saveInstructions() {
    if (!instructions.trim()) {
      toast.error("Instructions cannot be empty");
      return;
    }
    setSaving(true);
    try {
      await api.system.updateWorkspaceInstructions(instructions);
      setOriginalInstructions(instructions);
      setEditingInstructions(false);
      toast.success("Instructions saved");
      setVersionsKey((k) => k + 1);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save instructions");
    } finally {
      setSaving(false);
    }
  }

  function handleInstructionsRollback(content: string) {
    setInstructions(content);
    setOriginalInstructions(content);
    setEditingInstructions(false);
    setVersionsKey((k) => k + 1);
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <EmilyAvatar size="md" />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Emily</h1>
              <p className="text-xs text-muted-foreground">Chief of Staff</p>
            </div>
          </div>
          {agent?.model ? (
            <Badge variant="outline" className="font-mono text-xs">
              {agent.model}
            </Badge>
          ) : null}
          {/* Visibility (Share) control: Private <-> Shared with workspace.
              The assistant is a shared workspace tool (default Shared). STEP 5. */}
          {agent ? (
            <span className="ml-auto">
              <AssetVisibilityControl
                visibility={agent.visibility}
                canShare={agent.permissions?.can_share ?? true}
                noun="Emily"
                titleLabel="Emily visibility"
                onApply={async (next) => {
                  const updated = await api.system.setAssistantVisibility(next);
                  setAgent(updated);
                  return updated.visibility;
                }}
              />
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Emily&apos;s persona, workspace notes, and compiled prompt live here.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn&apos;t load the assistant</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={tab} onValueChange={changeTab}>
        <div className="-mx-1 max-w-full overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsList>
            <TabsTrigger value="base">Persona</TabsTrigger>
            <TabsTrigger value="instructions">Workspace notes</TabsTrigger>
            <TabsTrigger value="prompt">Compiled prompt</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="base" className="space-y-3">
          {loading ? (
            <>
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-80 w-full" />
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-medium">Emily persona</h2>
                    <Badge variant="outline" className="text-xs">
                      {baseIsCustom ? "Custom" : "Built-in default"}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Emily&apos;s core identity and style.
                  </p>
                </div>
                {editingBase ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setBase(originalBase);
                        setEditingBase(false);
                      }}
                      disabled={savingBase}
                    >
                      <X className="size-3.5" />
                      Cancel
                    </Button>
                    <Button size="sm" onClick={saveBase} disabled={!baseDirty || savingBase}>
                      <Save className="size-3.5" />
                      {savingBase ? "Saving" : "Save"}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <HistoryMenu
                      refreshKey={baseVersionsKey}
                      loadVersions={() => api.system.listWorkspaceBaseVersions()}
                      rollback={(id) => api.system.rollbackWorkspaceBasePersona(id)}
                      onRollback={handleBaseRollback}
                      confirmLabel="This will overwrite your current base instructions."
                    />
                    {baseIsCustom ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setResetConfirm(true)}
                        disabled={resetting}
                      >
                        <RotateCcw className="size-3.5" />
                        Reset to default
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" onClick={() => setEditingBase(true)}>
                      <Edit3 className="size-3.5" />
                      Edit
                    </Button>
                  </div>
                )}
              </div>
              <Textarea
                value={base}
                onChange={(event) => {
                  if (editingBase) setBase(event.target.value);
                }}
                readOnly={!editingBase}
                className="min-h-[28rem] font-mono text-xs leading-relaxed read-only:bg-muted/40"
                spellCheck={false}
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="instructions" className="space-y-3">
          {loading ? (
            <>
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-80 w-full" />
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium">Workspace notes</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Workspace-specific context and preferences.
                  </p>
                </div>
                {editingInstructions ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setInstructions(originalInstructions);
                        setEditingInstructions(false);
                      }}
                      disabled={saving}
                    >
                      <X className="size-3.5" />
                      Cancel
                    </Button>
                    <Button size="sm" onClick={saveInstructions} disabled={!dirty || saving}>
                      <Save className="size-3.5" />
                      {saving ? "Saving" : "Save"}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <HistoryMenu
                      refreshKey={versionsKey}
                      loadVersions={() => api.system.listWorkspaceVersions()}
                      rollback={(id) => api.system.rollbackWorkspaceInstructions(id)}
                      onRollback={handleInstructionsRollback}
                      confirmLabel="This will overwrite your current workspace instructions."
                    />
                    <Button size="sm" variant="outline" onClick={() => setEditingInstructions(true)}>
                      <Edit3 className="size-3.5" />
                      Edit
                    </Button>
                  </div>
                )}
              </div>
              <Textarea
                value={instructions}
                onChange={(event) => {
                  if (editingInstructions) setInstructions(event.target.value);
                }}
                readOnly={!editingInstructions}
                className="min-h-[28rem] font-mono text-xs leading-relaxed read-only:bg-muted/40"
                spellCheck={false}
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="prompt" className="space-y-3">
          {loading || !agent ? (
            <Skeleton className="h-96 w-full" />
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium">Compiled prompt</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Read-only preview of Emily&apos;s full system prompt.
                  </p>
                </div>
                <Badge variant="outline" className="text-xs">Read-only</Badge>
              </div>
              <pre className="max-h-[42rem] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-button)] border border-[var(--border-default)] bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">
                {agent.system_prompt}
              </pre>
            </>
          )}
        </TabsContent>

      </Tabs>

      <Dialog
        open={resetConfirm}
        onOpenChange={(open) => { if (!open) setResetConfirm(false); }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset base instructions?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            This removes your custom base instructions and restores the built-in default. Your
            current version is saved to history first, so you can roll back.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetConfirm(false)} disabled={resetting}>
              Cancel
            </Button>
            <Button onClick={() => void resetBase()} disabled={resetting}>
              {resetting ? "Resetting" : "Reset to default"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="text-xs text-muted-foreground">
        To use this assistant from Slack, go to{" "}
        <a href="/settings#slack" className="font-medium text-foreground underline-offset-2 hover:underline">
          Settings &rarr; Slack
        </a>
        .
      </p>
    </div>
  );
}
