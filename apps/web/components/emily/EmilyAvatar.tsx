import { Radar } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * EmilyAvatar — the Emily assistant identity mark.
 *
 * Accent circle with a Lucide Radar icon (white stroke).
 * Radar evokes active scanning and discovery, fitting for an assistant that
 * helps inspect workers, runs, and workspace state.
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
        "relative shrink-0 inline-flex items-center justify-center rounded-[var(--radius-squircle)] bg-[var(--emily-mark)]",
        sz,
      )}
      aria-label="Emily, chief of staff"
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
