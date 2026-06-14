import { Radar } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * EmilyAvatar — the Floom Emily identity mark.
 *
 * Floom-blue accent circle with a Lucide Radar icon (white stroke).
 * Radar evokes active scanning/discovery — fitting for Emily as the NovaSearch
 * recruiting agent. Stays clean and symmetric at small (24px) sizes where
 * Telescope became muddy. The blue (#3E6FE0 light / #5B8DEF dark) is the Floom
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
        "relative shrink-0 inline-flex items-center justify-center rounded-full bg-[var(--emily-mark)]",
        sz,
      )}
      aria-label="Emily, Chief of Staff"
    >
      <Radar
        size={iconSize}
        strokeWidth={2}
        className="text-white"
        aria-hidden="true"
      />
    </span>
  );
}
