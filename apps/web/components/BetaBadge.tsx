import { cn } from "@/lib/utils";

export function BetaBadge({ className }: { className?: string }) {
  return (
    <span
      title="Floom is in beta"
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-[var(--r-pill)] border border-[var(--border)] px-1.5 text-[10px] font-medium leading-none text-[var(--ink-mute)]",
        className,
      )}
    >
      Beta
    </span>
  );
}
