"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Save } from "lucide-react";

import { api } from "@/lib/api";
import type { WorkspaceAgentInfo } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type TabKey = "instructions" | "prompt" | "tools" | "channels";

const TABS: TabKey[] = ["instructions", "prompt", "tools", "channels"];

function validTab(value: string): value is TabKey {
  return TABS.includes(value as TabKey);
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
  const [error, setError] = useState<string | null>(null);

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
      toast.success("Instructions saved");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save instructions");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agent</h1>
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
            <TabsTrigger value="prompt">Resolved prompt</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
            <TabsTrigger value="channels">Channels</TabsTrigger>
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
                <Button size="sm" onClick={saveInstructions} disabled={!dirty || saving}>
                  <Save className="size-3.5" />
                  {saving ? "Saving" : "Save"}
                </Button>
              </div>
              <Textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                className="min-h-[28rem] font-mono text-xs leading-relaxed"
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
                <h2 className="text-sm font-medium">Resolved system prompt</h2>
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
              <CheckCircle2 className="mt-0.5 size-4 text-[var(--positive)]" />
              <div>
                <h2 className="text-sm font-medium">Slack</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Slack uses the same workspace instructions plus the Slack connection selected by the worker or listener.
                </p>
              </div>
            </div>
          </section>
          <section className="rounded-[var(--radius-card)] border border-line bg-card p-4">
            <h2 className="text-sm font-medium">Connections</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              OAuth and MCP credentials are managed on the Connections page.
            </p>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
