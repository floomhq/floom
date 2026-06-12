import { cn } from "@/lib/utils";

/**
 * EmilyAvatar — the Floom Emily identity mark.
 *
 * Federico 2026-06-12: refined blue "E" monogram, no sparkle, no gradient.
 * The fill is tokenized as --emily-mark so the rail, empty state, bubbles, and
 * settings all carry the same calm identity in light and dark mode.
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
          "relative inline-flex items-center justify-center rounded-[var(--radius-button)] bg-[var(--emily-mark)] font-semibold leading-none text-white",
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
