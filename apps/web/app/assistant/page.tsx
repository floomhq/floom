"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Edit3, Save, X } from "lucide-react";

import { api } from "@/lib/api";
import type { VersionSummary, WorkspaceAgentInfo } from "@/lib/types";
import { formatRelative } from "@/lib/formatters";
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

type TabKey = "instructions" | "prompt";

const TABS: TabKey[] = ["instructions", "prompt"];

function validTab(value: string): value is TabKey {
  return TABS.includes(value as TabKey);
}

// Inline "Versions ▾" dropdown for workspace instructions. Lazily loads the
// version list when opened and rolls back in place — no separate tab/page.
function InstructionsHistoryMenu({
  onRollback,
  refreshKey,
}: {
  onRollback: (content: string) => void;
  refreshKey: number;
}) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<VersionSummary | null>(null);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    try {
      setVersions(await api.system.listWorkspaceVersions());
    } catch {
      setVersions([]);
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, []);

  // Re-fetch when a save/rollback bumps the key, but only if already opened
  // once (avoids fetching for users who never open the dropdown).
  useEffect(() => {
    if (loadedOnce) void loadVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  function handleRollback(v: VersionSummary) {
    setPendingRestore(v);
  }

  async function doRollback() {
    if (!pendingRestore) return;
    const v = pendingRestore;
    setPendingRestore(null);
    setRollingBack(v.id);
    try {
      const content = await api.system.rollbackWorkspaceInstructions(v.id);
      onRollback(content);
      await loadVersions();
      toast.success(`Rolled back to commit ${v.sha}`);
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
          if (!loadedOnce) void loadVersions();
        }}
        onRestore={(v) => handleRollback(v)}
      />

      <Dialog
        open={!!pendingRestore}
        onOpenChange={(open) => { if (!open) setPendingRestore(null); }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Restore commit {pendingRestore?.sha}?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            This will overwrite your current workspace instructions. The current version is saved automatically before restoring.
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
      : "instructions";
  const [tab, setTab] = useState<TabKey>(initial);
  const [agent, setAgent] = useState<WorkspaceAgentInfo | null>(null);
  const [instructions, setInstructions] = useState("");
  const [originalInstructions, setOriginalInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versionsKey, setVersionsKey] = useState(0);

  const dirty = instructions !== originalInstructions;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentRes, instructionsRes] = await Promise.all([
        api.system.workspaceAgent(),
        api.system.workspaceInstructions(),
      ]);
      setAgent(agentRes);
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
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Assistant</h1>
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
                noun="assistant"
                titleLabel="Assistant visibility"
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
          Your interactive workspace assistant — chat with it to get help and orchestrate your
          workers. It reads the same Brain your workers use and can use your Connections read-only;
          actions that would change a live connection need your approval. Workers run autonomously
          on triggers; the assistant is interactive.
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
            <TabsTrigger value="instructions">Instructions</TabsTrigger>
            <TabsTrigger value="prompt">Final prompt</TabsTrigger>
          </TabsList>
        </div>

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
                  <h2 className="text-sm font-medium">Workspace instructions</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Saved in workspace.md and prepended to the agent prompt.
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
                    <InstructionsHistoryMenu
                      refreshKey={versionsKey}
                      onRollback={handleInstructionsRollback}
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
                  <h2 className="text-sm font-medium">Final system prompt</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Read-only preview of the base agent prompt plus your saved workspace instructions.
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
