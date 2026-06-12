import { cn } from "@/lib/utils";

/**
 * EmilyAvatar — the WorkerOS Emily identity mark.
 *
 * Federico 2026-06-12: no decorative glyph. The shared mark is a quiet, flat
 * accent circle so the rail, empty state, bubbles, and settings all carry the
 * same calm Emily identity.
 */
export function EmilyAvatar({ size = "md" }: { size?: "sm" | "md" }) {
  const isSmall = size === "sm";
  const sz = isSmall ? "size-6" : "size-8";
  const textSize = isSmall ? "text-[11px]" : "text-sm";
  return (
    <span
      className={cn("relative shrink-0 inline-flex items-center justify-center", sz)}
      aria-label="Emily, Chief of Staff"
    >
      <span
        className={cn(
          "relative inline-flex items-center justify-center rounded-full bg-[var(--accent)] font-semibold leading-none text-white",
          sz,
          textSize,
        )}
        aria-hidden="true"
      >
        E
      </span>
    </span>
  );
}
