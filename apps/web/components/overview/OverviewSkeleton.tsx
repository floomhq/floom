import { Skeleton } from "@/components/ui/skeleton";

export function OverviewSkeleton() {
  return (
    <div className="space-y-6 pt-10">
      <section>
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64 mt-2" />
      </section>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] p-6">
            <Skeleton className="h-9 w-20 rounded-lg" />
            <Skeleton className="h-4 w-28 mt-2" />
            <Skeleton className="h-3 w-24 mt-2" />
          </div>
        ))}
      </div>
      <Skeleton className="h-4 w-80" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] p-6 lg:col-span-2 space-y-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-lg" />
          ))}
        </div>
        <div className="rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] p-6 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
