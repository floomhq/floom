import { cn } from "@/lib/utils";
import { Sparkles } from "lucide-react";

/**
 * EmilyAvatar — the WorkerOS Emily identity mark.
 *
 * Wireframe spec: radial gradient (#7aa0ff → accent) with a white sparkle icon
 * and a subtle pulse ring on the "md" size (used in empty-state and headers).
 * "sm" size (used inline in message threads) skips the pulse to avoid visual noise.
 */
export function EmilyAvatar({ size = "md" }: { size?: "sm" | "md" }) {
  const isSmall = size === "sm";
  const sz = isSmall ? "size-6" : "size-8";
  return (
    <span
      className={cn("relative shrink-0 inline-flex items-center justify-center", sz)}
      aria-label="Emily, Chief of Staff"
    >
      {/* Pulse ring — md only, not in every message bubble */}
      {!isSmall && (
        <span
          className="absolute inset-0 rounded-full opacity-30 animate-ping"
          style={{ background: "var(--accent)" }}
          aria-hidden="true"
        />
      )}
      {/* Avatar circle with radial gradient mark */}
      <span
        className={cn("relative rounded-full shadow-sm", sz)}
        style={{
          background:
            "radial-gradient(circle at 35% 35%, #7aa0ff 0%, var(--accent) 70%)",
        }}
        aria-hidden="true"
      >
        <Sparkles
          className={cn(
            "absolute inset-0 m-auto text-white pointer-events-none",
            isSmall ? "size-3" : "size-4"
          )}
          strokeWidth={2.4}
          aria-hidden="true"
        />
      </span>
    </span>
  );
}
