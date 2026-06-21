import { cn } from "@/lib/utils";
import { GenerativeAvatar } from "@/components/GenerativeAvatar";

/**
 * EmilyAvatar — the Emily assistant identity mark.
 *
 * Generative avatar with a fixed seed "Emily" and a pinned blue palette
 * (product accent #3E6FE0). Squircle shape: Emily is an AI worker, not a
 * human user.
 *
 * No letter monogram, no icon, no emoji.
 */

const EMILY_PALETTE: [string, string, string] = ["#3E6FE0", "#22D3EE", "#6D5DF6"];

export function EmilyAvatar({ size = "md" }: { size?: "sm" | "md" }) {
  const isSmall = size === "sm";
  const pxSize = isSmall ? 24 : 32;
  return (
    <span
      className={cn(
        "relative shrink-0 inline-flex items-center justify-center",
        isSmall ? "size-6" : "size-8",
      )}
      aria-label="Emily, Chief of Staff"
    >
      <GenerativeAvatar
        seed="Emily"
        shape="squircle"
        size={pxSize}
        palette={EMILY_PALETTE}
      />
    </span>
  );
}
