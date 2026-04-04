"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

export function CodeTab({
  automationId,
  currentVersionId,
  currentVersion,
}: {
  automationId: Id<"automations">;
  currentVersionId: Id<"automationVersions">;
  currentVersion: number;
}) {
  const version = useQuery(api.automations.getVersion, {
    versionId: currentVersionId,
  });

  if (!version) {
    return <div className="p-4 text-sm text-gray-400 animate-pulse">Loading code...</div>;
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-700">
          Current code — v{currentVersion}
        </h3>
        <span className="text-xs text-gray-400">Read-only</span>
      </div>
      <div className="border border-gray-200 rounded overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
          <span className="text-xs font-mono text-gray-500">automation.py</span>
          <span className="text-xs text-gray-400">
            {new Date(version.createdAt).toLocaleDateString()}
            {version.changeNote && ` · ${version.changeNote}`}
          </span>
        </div>
        <pre className="p-4 text-xs overflow-x-auto bg-gray-950 text-gray-100 max-h-[60vh] overflow-y-auto">
          {version.code}
        </pre>
      </div>
      <p className="mt-3 text-xs text-gray-500">
        To update: run{" "}
        <code className="bg-gray-100 px-1 py-0.5 rounded font-mono">
          /floom
        </code>{" "}
        in Claude Code.
      </p>
    </div>
  );
}
