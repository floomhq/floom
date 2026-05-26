import { Skeleton } from "@/components/ui/skeleton";

export function ConnectionSkeleton() {
  return (
    <div className="rounded-lg border border-[var(--line)] bg-[var(--glass-bg-strong)] p-4">
      <div className="grid min-h-[116px] grid-cols-[minmax(0,1fr)_auto] gap-4">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            <Skeleton className="size-10 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
              <Skeleton className="mt-2 h-3 w-52 max-w-full" />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Skeleton className="h-5 w-28 rounded-full" />
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="mt-3 h-3 w-36" />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-start">
          <Skeleton className="h-7 w-[106px] rounded-lg" />
          <Skeleton className="h-7 w-[106px] rounded-lg" />
          <Skeleton className="size-7 rounded-lg" />
        </div>
      </div>
    </div>
  );
}
