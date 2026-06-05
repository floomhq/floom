import { cn } from "@/lib/utils";

/**
 * EmilyAvatar -- the Workeros Emily identity mark.
 * A small circle using the Emily accent color (#59AAF8).
 * No sparkles, no AI slop, just the brand color.
 */
export function EmilyAvatar({ size = "md" }: { size?: "sm" | "md" }) {
  const sz = size === "sm" ? "size-6" : "size-8";
  return (
    <div
      className={cn(
        sz,
        "shrink-0 rounded-full flex items-center justify-center text-white font-semibold text-[11px] shadow-sm"
      )}
      style={{ background: "#59AAF8" }}
      aria-label="Emily, Chief of Staff"
    >
      E
    </div>
  );
}
