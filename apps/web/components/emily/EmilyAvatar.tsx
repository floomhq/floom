import { cn } from "@/lib/utils";

/**
 * EmilyAvatar — the Floom Emily identity mark.
 *
 * The NovaSearch Emily mark (Federico 2026-06-13): a dark-green circle with a
 * white "E" and a white 4-point sparkle at the upper right. The green is
 * tokenized as --emily-mark so every Emily surface carries the same identity in
 * light and dark mode.
 */
export function EmilyAvatar({ size = "md" }: { size?: "sm" | "md" }) {
  const isSmall = size === "sm";
  const sz = isSmall ? "size-6" : "size-8";
  const textSize = isSmall ? "text-[11px]" : "text-sm";
  const star = isSmall ? "h-2 w-2" : "h-2.5 w-2.5";
  return (
    <span
      className={cn("relative shrink-0 inline-flex items-center justify-center", sz)}
      aria-label="Emily, Chief of Staff"
    >
      <span
        className={cn(
          "relative inline-flex items-center justify-center rounded-full bg-[var(--emily-mark)] font-semibold leading-none text-white",
          sz,
          textSize,
        )}
        aria-hidden="true"
      >
        E
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className={cn("absolute text-white", star)}
          style={{ top: isSmall ? "2px" : "3px", right: isSmall ? "2px" : "3px" }}
          aria-hidden="true"
        >
          {/* 4-point sparkle */}
          <path d="M12 0c0 6.627-5.373 12-12 12 6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12z" />
        </svg>
      </span>
    </span>
  );
}
