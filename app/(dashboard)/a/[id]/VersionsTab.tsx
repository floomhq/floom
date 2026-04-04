"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

export function VersionsTab({
  automationId,
}: {
  automationId: Id<"automations">;
}) {
  const versions = useQuery(api.automations.getVersions, { automationId });

  if (!versions) {
    return <div className="p-4 text-sm text-gray-400 animate-pulse">Loading versions...</div>;
  }

  return (
    <div className="p-4">
      <h3 className="text-sm font-medium text-gray-700 mb-3">Version history</h3>
      <div className="space-y-2">
        {versions.map((v, i) => (
          <div
            key={v._id}
            className="flex items-start gap-3 py-3 border-b border-gray-100 last:border-0"
          >
            <span className="text-xs font-medium text-gray-400 w-6 text-right mt-0.5">
              v{v.version}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-600">
                  {new Date(v.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                {v.runCount > 0 && (
                  <span className="text-xs text-gray-400">
                    · {v.runCount} run{v.runCount !== 1 ? "s" : ""}
                  </span>
                )}
                {i === 0 && (
                  <span className="text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-medium">
                    current
                  </span>
                )}
              </div>
              {v.changeNote && (
                <p className="text-xs text-gray-700 mt-0.5">{v.changeNote}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
