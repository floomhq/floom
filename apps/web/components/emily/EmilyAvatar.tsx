import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * EmilyAvatar — the Floom Emily identity mark.
 *
 * Floom-blue accent circle with a Lucide Star icon (white, filled).
 * Matches the NovaSearch star iconography used across the app for
 * consistency. The blue (#3E6FE0 light / #5B8DEF dark) is the Floom
 * accent, tokenized via --emily-mark.
 *
 * No letter monogram, no sparkle.
 */
export function EmilyAvatar({ size = "md" }: { size?: "sm" | "md" }) {
  const isSmall = size === "sm";
  const sz = isSmall ? "size-6" : "size-8";
  // Icon size: 14px inside 24px circle (sm) / 18px inside 32px circle (md)
  const iconSize = isSmall ? 14 : 18;
  return (
    <span
      className={cn(
        "relative shrink-0 inline-flex items-center justify-center rounded-[var(--radius-ui)] bg-[var(--emily-mark)]",
        sz,
      )}
      aria-label="Emily, Chief of Staff"
    >
      <Star
        size={iconSize}
        strokeWidth={1.5}
        fill="currentColor"
        className="text-white"        aria-hidden="true"
      />
    </span>
  );
}
