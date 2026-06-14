import { Skeleton } from "@/components/ui/skeleton";

// S29n: was the pre-S27 card-style layout (min-h-116 grid 2-col). The live
// /connections Connected tab is a row table; the skeleton now matches the
// 6-col grid in ConnectionRow.tsx so loading state doesn't visibly snap into
// a different shape when data arrives.
export function ConnectionSkeleton() {
  return (
    <div className="grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(0,1.5fr)_minmax(0,1fr)_120px_140px_auto] gap-3 md:gap-4 items-center px-3 py-2.5 [border-bottom:var(--bd-div)] last:[border-bottom:0]">
      <Skeleton className="size-8 rounded-[var(--radius-ui)]" />
      <div className="min-w-0 space-y-1.5">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-20" />
      </div>
      <Skeleton className="hidden md:block h-3 w-24" />
      <Skeleton className="hidden md:block h-3 w-16" />
      <Skeleton className="hidden md:block h-3 w-20" />
      <div className="flex items-center gap-1 justify-end">
        <Skeleton className="h-7 w-16 rounded-[var(--radius-ui)]" />
        <Skeleton className="size-7 rounded-[var(--radius-ui)]" />
      </div>
    </div>
  );
}
