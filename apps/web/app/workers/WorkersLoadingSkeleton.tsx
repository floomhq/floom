"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function WorkersLoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-64 mt-2" />
      </div>
      <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="h-full overflow-hidden">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="size-5 rounded-[var(--radius-ui)]" />
              </div>
              <Skeleton className="h-5 w-24 rounded-[var(--radius-ui)]" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
              <div className="flex gap-1.5">
                <Skeleton className="h-5 w-14 rounded" />
                <Skeleton className="h-5 w-16 rounded" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
