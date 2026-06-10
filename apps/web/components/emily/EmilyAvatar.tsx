import { cn } from "@/lib/utils";

/**
 * EmilyAvatar -- the WorkerOS Emily identity mark.
 * Solid blue accent circle. No letter, no text-in-circle.
 */
export function EmilyAvatar({ size = "md" }: { size?: "sm" | "md" }) {
  const sz = size === "sm" ? "size-6" : "size-8";
  return (
    <div
      className={cn(sz, "shrink-0 rounded-full shadow-sm")}
      style={{ background: "#2563EB" }}
      aria-label="Emily, Chief of Staff"
    />
  );
}
