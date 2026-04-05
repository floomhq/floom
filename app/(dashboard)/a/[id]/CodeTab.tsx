"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useState } from "react";

export function CodeTab({
  automationId,
  currentVersionId,
}: {
  automationId: Id<"automations">;
  currentVersionId: Id<"automationVersions">;
}) {
  const versions = useQuery(api.automations.getVersions, { automationId });
  const [selectedVersionId, setSelectedVersionId] = useState<Id<"automationVersions">>(currentVersionId);

  const versionData = useQuery(api.automations.getVersion, {
    versionId: selectedVersionId,
  });

  if (!versions || !versionData) {
    return <div className="p-4 text-sm text-gray-400 animate-pulse">Loading code...</div>;
  }

  const selectedVersion = versions.find((v) => v._id === selectedVersionId);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-gray-700">Code</h3>
          <select
            value={selectedVersionId}
            onChange={(e) => setSelectedVersionId(e.target.value as Id<"automationVersions">)}
            className="text-xs border border-gray-200 rounded px-2 py-1 text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {versions.map((v) => (
              <option key={v._id} value={v._id}>
                v{v.version}
                {v._id === currentVersionId ? " (current)" : ""}
                {v.changeNote ? ` · ${v.changeNote}` : ""}
              </option>
            ))}
          </select>
        </div>
        <span className="text-xs text-gray-400">Read-only</span>
      </div>
      <div className="border border-gray-200 rounded overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
          <span className="text-xs font-mono text-gray-500">automation.py</span>
          <span className="text-xs text-gray-400">
            {selectedVersion && new Date(selectedVersion.createdAt).toLocaleDateString()}
            {selectedVersion?.changeNote && ` · ${selectedVersion.changeNote}`}
          </span>
        </div>
        <pre className="p-4 text-xs overflow-x-auto bg-gray-950 text-gray-100 max-h-[60vh] overflow-y-auto">
          {versionData.code}
        </pre>
      </div>
      {selectedVersionId !== currentVersionId && (
        <p className="mt-2 text-xs text-amber-600">
          Viewing v{selectedVersion?.version} — not the current version.
        </p>
      )}
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
