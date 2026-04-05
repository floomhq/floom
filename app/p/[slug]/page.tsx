"use client";

import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { use, useState, useCallback } from "react";
import { RunForm } from "@/components/automation/RunForm";
import { OutputPanel } from "@/components/automation/OutputPanel";
import { Id } from "@/convex/_generated/dataModel";
import { Lock, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SignInButton } from "@clerk/nextjs";

export default function PublishedPage({
  params: paramsPromise,
}: {
  params: Promise<{ slug: string }>;
}) {
  const params = use(paramsPromise);

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [viewToken, setViewToken] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const data = useQuery(api.automations.getPublished, { slug: params.slug });
  const triggerPublished = useMutation(api.runs.triggerPublished);
  const getPublishedUpload = useAction(api.files.getPublishedUploadUrl);
  const publishedRun = useQuery(
    api.runs.getPublishedRun,
    activeRunId && viewToken
      ? { runId: activeRunId as Id<"runs">, viewToken }
      : "skip"
  );

  const handleRun = useCallback(
    async (inputs: Record<string, unknown>) => {
      setIsRunning(true);
      try {
        const result = await triggerPublished({ slug: params.slug, inputs });
        setActiveRunId(result.runId);
        setViewToken(result.viewToken);
      } catch (e: unknown) {
        const message =
          e instanceof Error ? e.message : "Something went wrong";
        alert(message);
      } finally {
        setIsRunning(false);
      }
    },
    [params.slug, triggerPublished]
  );

  // Loading state
  if (data === undefined) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8 sm:px-6 sm:py-12">
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-64 mb-8" />
        <Skeleton className="h-10 w-full mb-4" />
        <Skeleton className="h-10 w-full mb-4" />
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }

  // Not found
  if (data === null) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold text-foreground mb-2">
          Automation not found
        </h1>
        <p className="text-sm text-muted-foreground">
          This automation doesn&apos;t exist or has been removed.
        </p>
      </div>
    );
  }

  // Unpublished
  if ("unpublished" in data) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold text-muted-foreground mb-2">
          No longer published
        </h1>
        <p className="text-sm text-muted-foreground">
          This automation is no longer available.
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Contact the owner for access.
        </p>
      </div>
    );
  }

  // Unavailable
  if ("unavailable" in data) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold text-foreground mb-2">
          {data.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          Temporarily unavailable. This automation is being updated.
        </p>
      </div>
    );
  }

  // Requires auth (email-gated, not signed in)
  if ("requiresAuth" in data) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold text-foreground mb-2">
          {data.name}
        </h1>
        <p className="text-sm text-muted-foreground mb-6">
          {data.description}
        </p>
        <div className="border rounded-lg p-6 max-w-sm mx-auto">
          <Lock className="size-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium mb-4">
            Sign in to run this automation
          </p>
          <SignInButton mode="modal">
            <Button className="w-full">Sign in</Button>
          </SignInButton>
        </div>
      </div>
    );
  }

  // Access denied (email-gated, wrong email)
  if ("accessDenied" in data) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold text-foreground mb-2">
          {data.name}
        </h1>
        <div className="border rounded-lg p-6 max-w-sm mx-auto">
          <ShieldX className="size-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium mb-1">
            You don&apos;t have access
          </p>
          <p className="text-xs text-muted-foreground">
            This automation is restricted. Contact the owner if you need access.
          </p>
        </div>
      </div>
    );
  }

  // Happy path — show form
  const manifest = data.manifest;
  const uploadAction = async (args: {
    filename: string;
    contentType: string;
  }) => {
    return getPublishedUpload({ slug: params.slug, ...args });
  };

  // Map publishedRun data to the Run type expected by OutputPanel
  const runData = publishedRun
    ? {
        _id: activeRunId!,
        status: publishedRun.status as
          | "pending"
          | "running"
          | "success"
          | "error"
          | "timeout",
        outputs: publishedRun.outputs,
        logs: publishedRun.logs ?? "",
        errorType: publishedRun.errorType ?? null,
        error: publishedRun.error ?? null,
        durationMs: publishedRun.durationMs ?? null,
        startedAt: Date.now(),
        version: 0,
        versionId: "",
      }
    : null;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 sm:px-6 sm:py-12">
      <h1 className="text-2xl font-semibold text-foreground">{data.name}</h1>
      <p className="text-sm text-muted-foreground mt-1">{data.description}</p>

      <div className="mt-8 flex flex-col md:flex-row gap-8">
        <div className="md:w-2/5 md:shrink-0">
          <RunForm
            manifest={manifest}
            onRun={handleRun}
            automationId={data.automationId ?? ""}
            isRunning={isRunning}
            getUploadUrlAction={uploadAction}
          />
        </div>

        <div className="md:flex-1 min-w-0">
          {(activeRunId || publishedRun) ? (
            <OutputPanel
              runId={activeRunId}
              lastRun={null}
              currentVersionId=""
              manifestOutputs={manifest?.outputs ?? []}
              runData={runData}
            />
          ) : (
            <div className="hidden md:flex flex-col items-center justify-center h-full min-h-[200px] text-center border rounded-lg bg-muted/20">
              <p className="text-sm text-muted-foreground">Run this automation to see output here</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
