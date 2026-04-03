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
import { Share2, Eye, EyeOff, Pause, Play } from "lucide-react";

type Tab = "run" | "code" | "versions";

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

  const [tab, setTab] = useState<Tab>("run");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const setPublic = useMutation(api.automations.setPublic);
  const setScheduleEnabled = useMutation(api.automations.setScheduleEnabled);
  const triggerRun = useMutation(api.runs.trigger);

  const handleShare = useCallback(() => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleTogglePublic = useCallback(async () => {
    if (!automation) return;
    await setPublic({
      id: params.id as Id<"automations">,
      isPublicToOrg: !automation.isPublicToOrg,
    });
  }, [automation, params.id, setPublic]);

  const handleToggleSchedule = useCallback(async () => {
    if (!automation) return;
    const currentlyEnabled = automation.scheduleEnabled !== false;
    await setScheduleEnabled({
      id: params.id as Id<"automations">,
      enabled: !currentlyEnabled,
    });
  }, [automation, params.id, setScheduleEnabled]);

  const handleRun = useCallback(
    async (inputs: Record<string, unknown>) => {
      const result = await triggerRun({
        automationId: params.id as Id<"automations">,
        inputs,
        triggeredBy: "manual",
      });
      setActiveRunId(result.runId);
    },
    [params.id, triggerRun]
  );

  if (automation === undefined) {
    return (
      <div className="min-h-screen bg-white">
        <Nav />
        <div className="flex items-center justify-center h-64">
          <div className="animate-pulse text-gray-400 text-sm">Loading...</div>
        </div>
      </div>
    );
  }

  if (automation === null) {
    return (
      <div className="min-h-screen bg-white">
        <Nav />
        <div className="flex items-center justify-center h-64">
          <p className="text-gray-500">Automation not found.</p>
        </div>
      </div>
    );
  }

  const lastRun = automation.runs?.[0];

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Nav />

      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-medium text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
              v{automation.currentVersion}
            </span>
            <h1 className="font-semibold text-gray-900 truncate">
              {automation.name}
            </h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleShare}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded hover:bg-gray-50 transition-colors"
            >
              <Share2 size={14} />
              {copied ? "Copied!" : "Share"}
            </button>
            {automation.isOwner && automation.schedule && (
              <button
                onClick={handleToggleSchedule}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded hover:bg-gray-50 transition-colors"
                title={automation.scheduleEnabled === false ? "Resume schedule" : "Pause schedule"}
              >
                {automation.scheduleEnabled === false ? (
                  <>
                    <Play size={14} className="text-amber-500" />
                    <span>Paused</span>
                  </>
                ) : (
                  <>
                    <Pause size={14} className="text-gray-500" />
                    <span>Pause</span>
                  </>
                )}
              </button>
            )}
            {automation.isOwner && (
              <button
                onClick={handleTogglePublic}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded hover:bg-gray-50 transition-colors"
              >
                {automation.isPublicToOrg ? (
                  <>
                    <Eye size={14} className="text-emerald-500" />
                    <span>Public</span>
                  </>
                ) : (
                  <>
                    <EyeOff size={14} />
                    <span>Private</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
        <p className="text-sm text-gray-500 mt-0.5">{automation.description}</p>
        <div className="text-xs text-gray-400 mt-1 flex items-center gap-3">
          {lastRun && (
            <span>
              Last run{" "}
              {formatRelativeTime(lastRun.startedAt)}
            </span>
          )}
          {automation.schedule && (
            <span>Next: {describeSchedule(automation.schedule)}</span>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-200 px-4">
        {(["run", "code", "versions"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors capitalize ${
              tab === t
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Main content */}
      {tab === "run" && (
        <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
          {/* Left: Run form (55%) */}
          <div className="lg:w-[55%] border-b lg:border-b-0 lg:border-r border-gray-200 overflow-y-auto">
            <RunForm
              manifest={automation.manifest}
              onRun={handleRun}
              automationId={params.id}
            />
          </div>
          {/* Right: Output panel (45%) */}
          <div className="lg:w-[45%] overflow-y-auto">
            <OutputPanel
              runId={activeRunId}
              lastRun={lastRun ?? null}
              currentVersion={automation.currentVersion}
            />
          </div>
        </div>
      )}

      {tab === "code" && (
        <div className="flex-1 overflow-y-auto">
          <CodeTab
            automationId={params.id as Id<"automations">}
            currentVersionId={automation.currentVersionId as Id<"automationVersions">}
            currentVersion={automation.currentVersion}
          />
        </div>
      )}

      {tab === "versions" && (
        <div className="flex-1 overflow-y-auto">
          <VersionsTab automationId={params.id as Id<"automations">} />
        </div>
      )}

      {/* Run history */}
      {tab === "run" && (
        <div className="border-t border-gray-200">
          <RunHistory
            runs={automation.runs ?? []}
            onSelectRun={(runId) => setActiveRunId(runId)}
          />
        </div>
      )}
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
  // Very simple cron description — improve with a lib if needed
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;
  const [min, hour, , , dow] = parts;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (dow !== "*") {
    return `${days[parseInt(dow)] ?? "?"} ${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`;
  }
  return `Daily ${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`;
}
