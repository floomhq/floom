import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * EmilyAvatar — the Floom Emily identity mark.
 *
 * Dark-green squircle (#173B29 via --emily-mark) with a white Lucide Star.
 * Squircle shape uses --radius-ui (same rounded-square as WorkerAvatar) per
 * design-system no-round rule (#1103) and issue #1177.
 * Sizes: sm = 14px icon in 24px container, md = 18px icon in 32px container.
 */export function EmilyAvatar({ size = "md" }: { size?: "sm" | "md" }) {
  const isSmall = size === "sm";
  const sz = isSmall ? "size-6" : "size-8";
  // Icon size: 14px inside 24px circle (sm) / 18px inside 32px circle (md)
  const iconSize = isSmall ? 14 : 18;
  return (
    <span
      className={cn(
        "relative shrink-0 inline-flex items-center justify-center rounded-[var(--radius-ui)] bg-[var(--emily-mark)]",
        sz,      )}
      aria-label="Emily, Chief of Staff"
    >
      <Star
        size={iconSize}
        strokeWidth={1.5}
        fill="currentColor"
        className="text-white"        aria-hidden="true"
      />    </span>
  );
}
