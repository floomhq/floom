import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/Avatar";

/**
 * EmilyAvatar — the Emily assistant identity mark (locked SPEC).
 *
 * Solid accent-blue squircle + the fixed A4 mark (white core disc + two
 * white@55% energy arcs). Emily is an AI worker, not a human, so the shape is
 * a squircle. No letters, no icon, no emoji, no radar/orbit glyph.
 *
 * `active` makes the energy arcs gently pulse while Emily is working
 * (reduced-motion safe — see globals.css). Pass it from the typing indicator.
 */
export function EmilyAvatar({
  size = "md",
  active = false,
}: {
  size?: "sm" | "md";
  active?: boolean;
}) {
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
      <Avatar role="emily" size={pxSize} active={active} />
    </span>
  );
}
