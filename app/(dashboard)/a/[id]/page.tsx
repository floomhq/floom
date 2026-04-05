"use client";

import { useQuery, useMutation, useConvexAuth } from "convex/react";
import { use } from "react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useState, useCallback } from "react";
import { Nav } from "@/components/Nav";
import { StatusDot } from "@/components/ui/StatusDot";
import { RunForm } from "@/components/automation/RunForm";
import { OutputPanel } from "@/components/automation/OutputPanel";
import { RunHistory } from "./RunHistory";
import { CodeTab } from "./CodeTab";
import { VersionsTab } from "./VersionsTab";
import { SecretsTab } from "./SecretsTab";
import { Share2, Pause, Play, MoreHorizontal, Trash2, Globe } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishAccess, setPublishAccess] = useState<"public" | "email">("public");
  const [publishEmails, setPublishEmails] = useState("");
  const [publishCopied, setPublishCopied] = useState(false);

  const setScheduleEnabled = useMutation(api.automations.setScheduleEnabled);
  const triggerRun = useMutation(api.runs.trigger);
  const removeAutomation = useMutation(api.automations.remove);
  const publishAutomation = useMutation(api.automations.publish);
  const unpublishAutomation = useMutation(api.automations.unpublish);
  const updatePublishAccess = useMutation(api.automations.updatePublishAccess);

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

  const handlePublish = useCallback(async () => {
    if (!automation) return;
    await publishAutomation({
      automationId: params.id as Id<"automations">,
      access: publishAccess,
      allowedEmails:
        publishAccess === "email"
          ? publishEmails
              .split(",")
              .map((e) => e.trim())
              .filter(Boolean)
          : undefined,
    });
  }, [automation, params.id, publishAutomation, publishAccess, publishEmails]);

  const handleUnpublish = useCallback(async () => {
    await unpublishAutomation({
      automationId: params.id as Id<"automations">,
    });
  }, [params.id, unpublishAutomation]);

  const handleCopyPublishedUrl = useCallback(() => {
    if (!automation?.publishedSlug) return;
    navigator.clipboard.writeText(
      `${window.location.origin}/p/${automation.publishedSlug}`
    );
    setPublishCopied(true);
    setTimeout(() => setPublishCopied(false), 2000);
  }, [automation]);

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
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowPublishDialog(true)}
            >
              <Globe className="size-3.5" />
              {automation.publishedAt ? "Published" : "Publish"}
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

      {/* Publish dialog */}
      <Dialog open={showPublishDialog} onOpenChange={setShowPublishDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {automation.publishedAt ? "Published" : "Publish automation"}
            </DialogTitle>
            <DialogDescription>
              {automation.publishedAt
                ? "This automation is live. Anyone with the link can run it."
                : "Create a public link for this automation."}
            </DialogDescription>
          </DialogHeader>

          {automation.publishedAt ? (
            <div className="space-y-4">
              <div>
                <Label className="text-xs text-muted-foreground">
                  Published URL
                </Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    value={`${typeof window !== "undefined" ? window.location.origin : ""}/p/${automation.publishedSlug}`}
                    readOnly
                    className="text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyPublishedUrl}
                  >
                    {publishCopied ? "Copied!" : "Copy"}
                  </Button>
                </div>
              </div>
              <Separator />
              <DialogFooter className="flex-row gap-2 sm:justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleUnpublish}
                >
                  Unpublish
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex gap-2">
                <Button
                  variant={publishAccess === "public" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPublishAccess("public")}
                >
                  Public
                </Button>
                <Button
                  variant={publishAccess === "email" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPublishAccess("email")}
                >
                  By Email
                </Button>
              </div>
              {publishAccess === "email" && (
                <div>
                  <Label htmlFor="emails" className="text-sm">
                    Allowed emails
                  </Label>
                  <Input
                    id="emails"
                    placeholder="email@example.com, another@example.com"
                    value={publishEmails}
                    onChange={(e) => setPublishEmails(e.target.value)}
                    className="mt-1"
                  />
                </div>
              )}
              <DialogFooter>
                <Button onClick={handlePublish}>Publish</Button>
              </DialogFooter>
            </div>
          )}
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
