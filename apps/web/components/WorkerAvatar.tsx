// S29n: deterministic per-worker avatar. Federico (2026-05-28): workers
// should feel like employees, not scripts. Avatar makes the worker feel
// like a person on a team.
//
// Behavior:
// - Hash the worker name (or id) into a stable hue in 0..360.
// - Render a circular gradient from hue->hue+30 with the worker's initials.
// - One worker, one stable color, across cards / detail / runs.
import { cn } from "@/lib/utils";

interface WorkerAvatarProps {
  // Worker name OR id - the seed used to derive the gradient. Pass the most
  // stable identifier you have so the color doesn't change on rename.
  seed: string;
  // Display label - used to extract initials. Defaults to seed.
  name?: string;
  className?: string;
  // Tailwind size class. Default size-9.
  size?: string;
}

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function initials(name: string): string {
  const cleaned = name.replace(/[_-]+/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? "");
  return (first + second).toUpperCase();
}

export function WorkerAvatar({ seed, name, className, size = "size-9" }: WorkerAvatarProps) {
  const display = name || seed;
  const hue = hash(seed) % 360;
  const hue2 = (hue + 30) % 360;
  // Use HSL with consistent lightness/saturation so all avatars share a
  // visual register (no jarringly bright or dark cards). Tuned for both
  // light and dark themes.
  const bgGradient = `linear-gradient(135deg, hsl(${hue} 55% 56%) 0%, hsl(${hue2} 60% 48%) 100%)`;
  return (
    <div
      className={cn(
        "shrink-0 rounded-full grid place-items-center text-white font-semibold tracking-tight shadow-sm",
        size,
        className,
      )}
      style={{ background: bgGradient }}
      aria-label={`${display} avatar`}
    >
      <span className="text-[11px] leading-none drop-shadow-sm">{initials(display)}</span>
    </div>
  );
}
