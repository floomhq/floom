import { cn } from "@/lib/utils";

/**
 * EmilyAvatar — the WorkerOS Emily identity mark.
 *
 * Wireframe spec: radial gradient (#7aa0ff → accent) with a white sparkle overlay
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
        {/* White sparkle overlay — centred ✦ glyph */}
        <span
          className="absolute inset-0 flex items-center justify-center text-white select-none pointer-events-none"
          style={{
            fontSize: isSmall ? "9px" : "12px",
            lineHeight: 1,
            fontWeight: 700,
            opacity: 0.9,
          }}
          aria-hidden="true"
        >
          ✦
        </span>
      </span>
    </span>
  );
}
