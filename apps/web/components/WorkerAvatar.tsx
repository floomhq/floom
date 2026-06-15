// S29r: deterministic-hue gradient dropped. the operator (2026-05-28): "the
// placeholder should not have different colours. I don't like too many
// colours overall, as a rule." Single mono treatment across all workers,
// matching the floomhq/relay + skills-neo membership-mark pattern.
//
// Style: muted bg + foreground initials. One color register, no per-worker
// variation. Account/profile marks use the same rounded-square system shape as
// workspace and worker marks.
//
// M36: avatarUrl prop added for Google OAuth picture. The UI is wired;
// the backend MUST expose a `picture` (or `avatar_url`) field on the
// session/user object (e.g. GET /user/me → { picture: string | null })
// for this to populate. Fallback to initials when null/absent.
import { cn } from "@/lib/utils";

interface WorkerAvatarProps {
  // Kept for API compatibility — earlier S29n used `seed` for hue derivation.
  // No longer drives color; accept and ignore so existing call sites compile.
  seed?: string;
  // Display label used to extract initials. Falls back to seed.
  name?: string;
  className?: string;
  // Tailwind size class. Default size-9.
  size?: string;
  // M36: Google OAuth / provider avatar URL. When present, renders as <img>.
  // Backend dependency: GET /user/me must return { picture: string | null }.
  avatarUrl?: string | null;
}

function initials(name: string): string {
  const cleaned = name.replace(/[_-]+/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? "");
  return (first + second).toUpperCase();
}

export function WorkerAvatar({ seed, name, className, size = "size-9", avatarUrl }: WorkerAvatarProps) {
  const display = name || seed || "?";
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={`${display} avatar`}
        referrerPolicy="no-referrer"
        className={cn(
          "shrink-0 rounded-[var(--radius-ui)] object-cover",
          size,
          className,
        )}
        aria-label={`${display} avatar`}
      />
    );
  }
  return (
    <div
      className={cn(
        "shrink-0 rounded-[var(--radius-ui)] grid place-items-center font-medium tracking-tight bg-muted text-foreground",
        size,
        className,
      )}
      aria-label={`${display} avatar`}
    >
      <span className="text-[11px] leading-none">{initials(display)}</span>
    </div>
  );
}
