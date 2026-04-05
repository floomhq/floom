"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

export function VersionsTab({
  automationId,
}: {
  automationId: Id<"automations">;
}) {
  const versions = useQuery(api.automations.getVersions, { automationId });

  if (!versions) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  return (
    <div className="p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">
        Version history
      </h3>
      <div>
        {versions.map((v, i) => (
          <div key={v._id}>
            <div className="flex items-center gap-3 py-3">
              <Badge variant="outline" className="mt-0.5 shrink-0">
                v{v.version}
              </Badge>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {new Date(v.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  {v.runCount > 0 && (
                    <span className="text-xs text-muted-foreground/60">
                      &middot; {v.runCount} run{v.runCount !== 1 ? "s" : ""}
                    </span>
                  )}
                  {i === 0 && <Badge>current</Badge>}
                </div>
                {v.changeNote && (
                  <p className="text-xs text-foreground mt-0.5">
                    {v.changeNote}
                  </p>
                )}
              </div>
            </div>
            {i < versions.length - 1 && <Separator />}
          </div>
        ))}
      </div>
    </div>
  );
}
