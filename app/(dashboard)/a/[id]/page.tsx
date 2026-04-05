"use client";

import { useQuery, useMutation, useConvexAuth } from "convex/react";
import { use } from "react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useState, useCallback } from "react";
import { Nav } from "@/components/Nav";
import { StatusDot } from "@/components/ui/StatusDot";
import { RunForm } from "./RunForm";
import { OutputPanel } from "./OutputPanel";
import { RunHistory } from "./RunHistory";
import { CodeTab } from "./CodeTab";
import { VersionsTab } from "./VersionsTab";
import { SecretsTab } from "./SecretsTab";
import { Share2, Pause, Play, MoreHorizontal, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

export default function AutomationPage({
  params: paramsPromise,
}: {
  params: Promise<{ id: string }>;
}) {
  const params = use(paramsPromise);
  const { isAuthenticated } = useConvexAuth();
  const automation = useQuery(
    api.automations.get,
    isAuthenticated ? { id: params.id as Id<"automations"> } : "skip"
  );

  const router = useRouter();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const setScheduleEnabled = useMutation(api.automations.setScheduleEnabled);
  const triggerRun = useMutation(api.runs.trigger);
  const removeAutomation = useMutation(api.automations.remove);

  const handleShare = useCallback(() => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleToggleSchedule = useCallback(async () => {
    if (!automation) return;
    const currentlyEnabled = automation.scheduleEnabled !== false;
    await setScheduleEnabled({
      id: params.id as Id<"automations">,
      enabled: !currentlyEnabled,
    });
  }, [automation, params.id, setScheduleEnabled]);

  const handleDelete = useCallback(async () => {
    await removeAutomation({ id: params.id as Id<"automations"> });
    router.push("/gallery");
  }, [params.id, removeAutomation, router]);

  const handleRun = useCallback(
    async (inputs: Record<string, unknown>) => {
      setIsRunning(true);
      try {
        const result = await triggerRun({
          automationId: params.id as Id<"automations">,
          inputs,
          triggeredBy: "manual",
        });
        setActiveRunId(result.runId);
      } finally {
        setIsRunning(false);
      }
    },
    [params.id, triggerRun]
  );

  if (automation === undefined) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <div className="flex items-center justify-center h-64">
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
    );
  }

  if (automation === null) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Automation not found.</p>
        </div>
      </div>
    );
  }

  const lastRun = automation.runs?.[0];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Nav />

      {/* Header */}
      <div className="px-4 py-3 border-b">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant="secondary">v{automation.currentVersion}</Badge>
            <h1 className="font-semibold text-foreground truncate">
              {automation.name}
            </h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={handleShare}>
              <Share2 className="size-3.5" />
              {copied ? "Copied!" : "Share"}
            </Button>
            {automation.isOwner && automation.schedule && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleSchedule}
                title={
                  automation.scheduleEnabled === false
                    ? "Resume schedule"
                    : "Pause schedule"
                }
              >
                {automation.scheduleEnabled === false ? (
                  <>
                    <Play className="size-3.5 text-amber-500" />
                    <span>Paused</span>
                  </>
                ) : (
                  <>
                    <Pause className="size-3.5 text-muted-foreground" />
                    <span>Pause</span>
                  </>
                )}
              </Button>
            )}
            {automation.isOwner && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={cn(
                    buttonVariants({ variant: "outline", size: "icon" })
                  )}
                >
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 />
                    Delete automation
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          {automation.description}
        </p>
        <div className="text-xs text-muted-foreground/60 mt-1 flex items-center gap-3">
          {lastRun && (
            <span>Last run {formatRelativeTime(lastRun.startedAt)}</span>
          )}
          {automation.schedule && (
            <span>Next: {describeSchedule(automation.schedule)}</span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="run" className="flex-1 flex flex-col gap-0">
        <div className="px-4 py-2 border-b">
          <TabsList>
            <TabsTrigger value="run">Run</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
            {automation.isOwner && (
              <TabsTrigger value="secrets">Secrets</TabsTrigger>
            )}
          </TabsList>
        </div>

        <TabsContent value="run" className="flex-1 flex flex-col">
          <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
            {/* Left: Run form (40%) */}
            <div
              className={cn(
                "lg:w-[40%] border-b lg:border-b-0 lg:border-r overflow-y-auto transition-opacity duration-200",
                !isRunning && (lastRun || activeRunId)
                  ? "opacity-60"
                  : "opacity-100"
              )}
            >
              <RunForm
                manifest={automation.manifest}
                onRun={handleRun}
                automationId={params.id}
                isRunning={isRunning}
              />
            </div>
            {/* Right: Output panel (60%) */}
            <div
              className={cn(
                "lg:w-[60%] overflow-y-auto transition-opacity duration-200",
                isRunning
                  ? "opacity-100"
                  : !lastRun && !activeRunId
                    ? "opacity-40"
                    : "opacity-100"
              )}
            >
              <OutputPanel
                runId={activeRunId}
                lastRun={lastRun ?? null}
                currentVersionId={automation.currentVersionId as string}
                manifestOutputs={automation.manifest?.outputs ?? []}
              />
            </div>
          </div>

          {/* Run history */}
          <Separator />
          <RunHistory
            runs={automation.runs ?? []}
            onSelectRun={(runId) => setActiveRunId(runId)}
          />
        </TabsContent>

        <TabsContent value="code" className="flex-1 overflow-y-auto">
          <CodeTab
            automationId={params.id as Id<"automations">}
            currentVersionId={
              automation.currentVersionId as Id<"automationVersions">
            }
          />
        </TabsContent>

        <TabsContent value="versions" className="flex-1 overflow-y-auto">
          <VersionsTab automationId={params.id as Id<"automations">} />
        </TabsContent>

        {automation.isOwner && (
          <TabsContent value="secrets" className="flex-1 overflow-y-auto">
            <SecretsTab />
          </TabsContent>
        )}
      </Tabs>

      {/* Delete confirmation dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete automation</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium text-foreground">
                {automation.name}
              </span>
              ? This will permanently remove the automation, all versions, and
              run history. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function describeSchedule(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;
  const [min, hour, , , dow] = parts;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (dow !== "*") {
    return `${days[parseInt(dow)] ?? "?"} ${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`;
  }
  return `Daily ${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`;
}
