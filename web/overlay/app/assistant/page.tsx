"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Edit3, RotateCcw, Save, Trash2, X } from "lucide-react";

import { api, getActiveWorkspaceId } from "@/lib/api";
import type { ConnectionItem, VersionSummary, WorkspaceAgentInfo } from "@/lib/types";
import { formatRelative } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type TabKey = "instructions" | "prompt" | "tools" | "channels" | "versions";

const TABS: TabKey[] = ["instructions", "prompt", "tools", "channels", "versions"];
const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";

interface SlackBinding {
  id: string;
  workspace_id: string;
  channel_type: "slack";
  external_team_id?: string | null;
  external_channel_id: string;
  external_channel_name?: string | null;
  enabled: boolean;
  updated_at?: string;
}

interface WorkspaceAgentInfoWithSlackBinding extends WorkspaceAgentInfo {
  channels?: WorkspaceAgentInfo["channels"] & {
    slack?: NonNullable<NonNullable<WorkspaceAgentInfo["channels"]>["slack"]> & {
      binding?: SlackBinding | null;
    };
  };
}

function validTab(value: string): value is TabKey {
  return TABS.includes(value as TabKey);
}

function changeSourceLabel(src: string): string {
  if (src === "user") return "Manual save";
  if (src === "ai") return "AI edit";
  if (src.startsWith("rollback:")) return "Rollback";
  return src;
}

function changeSourceBadge(src: string) {
  const label = changeSourceLabel(src);
  const isRollback = src.startsWith("rollback:");
  const isAi = src === "ai";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium border",
        isRollback
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : isAi
            ? "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400"
            : "border-border bg-muted text-muted-foreground"
      )}
    >
      {label}
    </span>
  );
}

function workspaceHeaders(): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const activeWorkspaceId = getActiveWorkspaceId();
  if (activeWorkspaceId) headers.set("x-workeros-workspace", activeWorkspaceId);
  return headers;
}

async function fetchAgentJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: workspaceHeaders(),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch {
      detail = res.statusText || `HTTP ${res.status}`;
    }
    throw new Error(detail);
  }
  if (res.status === 204) return null as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (null as T);
}

async function saveSlackBinding(payload: {
  external_channel_id: string;
  external_channel_name?: string | null;
  external_team_id?: string | null;
  enabled: boolean;
}): Promise<SlackBinding | null> {
  const response = await fetchAgentJson<{ binding: SlackBinding | null }>(
    "/system/workspace-agent/channels/slack",
    { method: "PUT", body: JSON.stringify(payload) }
  );
  return response.binding;
}

async function deleteSlackBinding(): Promise<number> {
  const response = await fetchAgentJson<{ deleted: number }>(
    "/system/workspace-agent/channels/slack",
    { method: "DELETE" }
  );
  return response.deleted;
}

function WorkspaceInstructionsVersionsSection({
  onRollback,
}: {
  onRollback: (content: string) => void;
}) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [rollingBack, setRollingBack] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.system.listWorkspaceVersions();
      setVersions(rows);
    } catch {
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  async function handleRollback(v: VersionSummary) {
    if (
      !confirm(
        `Restore workspace instructions to version ${v.version_number} (saved ${formatRelative(v.created_at)})?\n\nThis will overwrite the current instructions.`
      )
    ) {
      return;
    }
    setRollingBack(v.id);
    try {
      const content = await api.system.rollbackWorkspaceInstructions(v.id);
      onRollback(content);
      await loadVersions();
      toast.success(`Rolled back to version ${v.version_number}`);
    } catch (e: unknown) {
      toast.error(`Rollback failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setRollingBack(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 space-y-2">
        <p className="text-sm font-medium text-foreground">No versions yet</p>
        <p className="text-xs text-muted-foreground">
          Versions are saved automatically each time workspace instructions are updated. Save
          instructions to create the first version.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {versions.length} version{versions.length !== 1 ? "s" : ""} · newest first
      </p>
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden divide-y divide-[var(--border-default)]">
        {versions.map((v, idx) => (
          <div key={v.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xs font-mono text-muted-foreground w-6 shrink-0 text-right">
                v{v.version_number}
              </span>
              <div className="min-w-0 flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  {changeSourceBadge(v.change_source)}
                  {idx === 0 && (
                    <span className="text-[10px] text-muted-foreground font-medium">(current)</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">{formatRelative(v.created_at)}</span>
              </div>
            </div>
            {idx !== 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={rollingBack === v.id}
                onClick={() => void handleRollback(v)}
                className="shrink-0 h-7 text-xs"
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                {rollingBack === v.id ? "Restoring…" : "Rollback"}
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AssistantPage() {
  const initial =
    typeof window !== "undefined" && validTab(window.location.hash.replace(/^#/, ""))
      ? (window.location.hash.replace(/^#/, "") as TabKey)
      : "instructions";
  const [tab, setTab] = useState<TabKey>(initial);
  const [agent, setAgent] = useState<WorkspaceAgentInfoWithSlackBinding | null>(null);
  const [instructions, setInstructions] = useState("");
  const [originalInstructions, setOriginalInstructions] = useState("");
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versionsKey, setVersionsKey] = useState(0);
  const [slackChannelId, setSlackChannelId] = useState("");
  const [slackChannelName, setSlackChannelName] = useState("");
  const [slackTeamId, setSlackTeamId] = useState("");
  const [slackBindingEnabled, setSlackBindingEnabled] = useState(true);
  const [savingSlack, setSavingSlack] = useState(false);

  const dirty = instructions !== originalInstructions;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentRes, instructionsRes, connectionRes] = await Promise.all([
        api.system.workspaceAgent(),
        api.system.workspaceInstructions(),
        api.connections.list(),
      ]);
      const typedAgent = agentRes as WorkspaceAgentInfoWithSlackBinding;
      const binding = typedAgent.channels?.slack?.binding;
      setAgent(typedAgent);
      setSlackChannelId(binding?.external_channel_id ?? "");
      setSlackChannelName(binding?.external_channel_name ?? "");
      setSlackTeamId(binding?.external_team_id ?? "");
      setSlackBindingEnabled(binding?.enabled ?? true);
      setInstructions(instructionsRes);
      setOriginalInstructions(instructionsRes);
      setConnections(connectionRes);
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
    window.history.replaceState(null, "", `${window.location.pathname}#${value}`);
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

  const slackConnections = connections.filter(
    (connection) => connection.kind !== "mcp" && connection.app_name.toLowerCase() === "slack"
  );
  const activeSlackConnections = slackConnections.filter((connection) => connection.status === "active");
  const slackEventsConfigured = Boolean(agent?.channels?.slack?.events_configured);
  const slackBotConfigured = Boolean(agent?.channels?.slack?.bot_configured);
  const slackBinding = agent?.channels?.slack?.binding ?? null;
  const slackBound = Boolean(slackBinding?.enabled && slackBinding.external_channel_id);
  const slackReady =
    activeSlackConnections.length > 0 && slackEventsConfigured && slackBotConfigured && slackBound;

  async function handleSaveSlackBinding() {
    if (!slackChannelId.trim()) {
      toast.error("Slack channel ID is required");
      return;
    }
    setSavingSlack(true);
    try {
      await saveSlackBinding({
        external_channel_id: slackChannelId.trim(),
        external_channel_name: slackChannelName.trim() || null,
        external_team_id: slackTeamId.trim() || null,
        enabled: slackBindingEnabled,
      });
      toast.success("Slack channel saved");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save Slack channel");
    } finally {
      setSavingSlack(false);
    }
  }

  async function handleDeleteSlackBinding() {
    setSavingSlack(true);
    try {
      await deleteSlackBinding();
      toast.success("Slack channel removed");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove Slack channel");
    } finally {
      setSavingSlack(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Agent</h1>
          {agent?.model ? (
            <Badge variant="outline" className="font-mono text-xs">
              {agent.model}
            </Badge>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspace instructions, tools, and channel wiring.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn&apos;t load the agent</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={tab} onValueChange={changeTab}>
        <div className="-mx-1 max-w-full overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsList>
            <TabsTrigger value="instructions">Instructions</TabsTrigger>
            <TabsTrigger value="prompt">Final prompt</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
            <TabsTrigger value="channels">Channels</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
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
                  <Button size="sm" variant="outline" onClick={() => setEditingInstructions(true)}>
                    <Edit3 className="size-3.5" />
                    Edit
                  </Button>
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

        <TabsContent value="tools" className="space-y-3">
          {loading || !agent ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <>
              <h2 className="text-sm font-medium">Tools</h2>
              <div className="divide-y divide-[var(--border-default)] rounded-[var(--radius-button)] border border-[var(--border-default)]">
                {agent.tools.map((tool) => (
                  <div key={tool.name} className="px-3 py-2.5">
                    <code className="text-xs font-medium text-foreground">{tool.name}</code>
                    {tool.description ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{tool.description}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="channels" className="space-y-4">
          <section className="rounded-[var(--radius-card)] border border-line bg-card p-4">
            <div className="flex items-start gap-3">
              {slackReady ? (
                <CheckCircle2 className="mt-0.5 size-4 text-[var(--positive)]" />
              ) : (
                <AlertTriangle className="mt-0.5 size-4 text-[var(--warning)]" />
              )}
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-medium">Slack</h2>
                  <Badge variant="outline" className="text-xs">
                    {slackReady
                      ? "Ready"
                      : activeSlackConnections.length > 0
                        ? "OAuth only"
                        : "Not connected"}
                  </Badge>
                </div>
                <div className="mt-2 grid gap-2 text-sm text-muted-foreground sm:grid-cols-4">
                  <ReadinessPill label="OAuth connection" ready={activeSlackConnections.length > 0} />
                  <ReadinessPill label="Events secret" ready={slackEventsConfigured} />
                  <ReadinessPill label="Bot token" ready={slackBotConfigured} />
                  <ReadinessPill label="Channel binding" ready={slackBound} />
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {slackReady
                    ? "Slack mentions route to this workspace agent."
                    : "Slack needs OAuth, Events API signing, bot reply credentials, and a channel binding."}
                </p>
              </div>
            </div>
          </section>
          <section className="rounded-[var(--radius-card)] border border-line bg-card p-4 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">Slack channel</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Bind one Slack channel to this workspace agent.
                </p>
              </div>
              {slackBinding ? (
                <Badge variant={slackBinding.enabled ? "default" : "outline"} className="text-xs">
                  {slackBinding.enabled ? "Enabled" : "Paused"}
                </Badge>
              ) : null}
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="slack-channel-id">Channel ID</Label>
                <Input
                  id="slack-channel-id"
                  value={slackChannelId}
                  onChange={(event) => setSlackChannelId(event.target.value)}
                  placeholder="C0123456789"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="slack-channel-name">Channel name</Label>
                <Input
                  id="slack-channel-name"
                  value={slackChannelName}
                  onChange={(event) => setSlackChannelName(event.target.value)}
                  placeholder="product"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="slack-enabled">Enabled</Label>
                <div className="flex h-10 items-center gap-2">
                  <Switch
                    id="slack-enabled"
                    checked={slackBindingEnabled}
                    onCheckedChange={setSlackBindingEnabled}
                  />
                  <span className="text-sm text-muted-foreground">
                    {slackBindingEnabled ? "On" : "Off"}
                  </span>
                </div>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="slack-team-id">Team ID</Label>
                <Input
                  id="slack-team-id"
                  value={slackTeamId}
                  onChange={(event) => setSlackTeamId(event.target.value)}
                  placeholder="T0123456789"
                  className="font-mono"
                />
              </div>
              <div className="flex items-end gap-2">
                {slackBinding ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleDeleteSlackBinding()}
                    disabled={savingSlack}
                  >
                    <Trash2 className="size-3.5" />
                    Remove
                  </Button>
                ) : null}
                <Button
                  type="button"
                  onClick={() => void handleSaveSlackBinding()}
                  disabled={savingSlack || !slackChannelId.trim()}
                >
                  <Save className="size-3.5" />
                  {savingSlack ? "Saving" : "Save"}
                </Button>
              </div>
            </div>
          </section>
          <section className="rounded-[var(--radius-card)] border border-line bg-card p-4">
            <h2 className="text-sm font-medium">Connection inventory</h2>
            <div className="mt-3 divide-y divide-[var(--border-default)] rounded-[var(--radius-button)] border border-[var(--border-default)]">
              {activeSlackConnections.length > 0 ? (
                activeSlackConnections.map((connection) => (
                  <div key={connection.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {connection.account_label || connection.display_name || connection.app_name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{connection.app_name}</p>
                    </div>
                    <Badge variant="outline" className="text-xs">Active</Badge>
                  </div>
                ))
              ) : (
                <div className="px-3 py-2.5 text-sm text-muted-foreground">
                  No active Slack OAuth connection.
                </div>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="versions" className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">Instruction versions</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Automatic snapshots on every save. Roll back to undo AI or manual changes.
            </p>
          </div>
          <WorkspaceInstructionsVersionsSection
            key={versionsKey}
            onRollback={handleInstructionsRollback}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ReadinessPill({ label, ready }: { label: string; ready: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-muted/30 px-2 py-1 text-xs">
      {ready ? (
        <CheckCircle2 className="size-3 text-[var(--positive)]" />
      ) : (
        <AlertTriangle className="size-3 text-[var(--warning)]" />
      )}
      {label}
    </span>
  );
}
