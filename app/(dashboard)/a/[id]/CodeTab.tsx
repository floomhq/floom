"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

export function CodeTab({
  automationId,
  currentVersionId,
}: {
  automationId: Id<"automations">;
  currentVersionId: Id<"automationVersions">;
}) {
  const versions = useQuery(api.automations.getVersions, { automationId });
  const [selectedVersionId, setSelectedVersionId] =
    useState<Id<"automationVersions">>(currentVersionId);

  const versionData = useQuery(api.automations.getVersion, {
    versionId: selectedVersionId,
  });

  if (!versions || !versionData) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const selectedVersion = versions.find((v: { _id: string }) => v._id === selectedVersionId);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-foreground">Code</h3>
          <Select
            value={selectedVersionId}
            onValueChange={(val) =>
              setSelectedVersionId(val as Id<"automationVersions">)
            }
          >
            <SelectTrigger size="sm">
              <SelectValue placeholder="Select version">
                {selectedVersion
                  ? `v${selectedVersion.version}${selectedVersion._id === currentVersionId ? " (current)" : ""}${selectedVersion.changeNote ? ` · ${selectedVersion.changeNote}` : ""}`
                  : "Select version"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v._id} value={v._id}>
                  v{v.version}
                  {v._id === currentVersionId ? " (current)" : ""}
                  {v.changeNote ? ` \u00B7 ${v.changeNote}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Badge variant="outline">Read-only</Badge>
      </div>
      <Card className="overflow-hidden p-0">
        <CardHeader className="flex items-center justify-between border-b bg-muted/50">
          <span className="text-xs font-mono text-muted-foreground">
            automation.py
          </span>
          <span className="text-xs text-muted-foreground">
            {selectedVersion &&
              new Date(selectedVersion.createdAt).toLocaleDateString()}
            {selectedVersion?.changeNote &&
              ` \u00B7 ${selectedVersion.changeNote}`}
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <pre className="p-4 text-xs overflow-x-auto bg-gray-950 text-gray-100 max-h-[60vh] overflow-y-auto">
            {versionData.code}
          </pre>
        </CardContent>
      </Card>
      {selectedVersionId !== currentVersionId && (
        <p className="mt-2 text-xs text-amber-600">
          Viewing v{selectedVersion?.version} — not the current version.
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        To update: run{" "}
        <code className="bg-muted px-1 py-0.5 rounded font-mono">/floom</code>{" "}
        in Claude Code.
      </p>
    </div>
  );
}
