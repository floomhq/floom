import { resolveWorkspaceName } from "@/lib/workspace/display-name";

/** Workspace identity mark — flat squircle monogram (G3/G4: no avatars, no
 *  DiceBear, no gradient). Derives 1–2 initials from the workspace name and
 *  renders them on a subtle DS surface. Mirrors UserInitialsAvatar so the
 *  workspace + user marks share one visual language. Used wherever the
 *  workspace has no real uploaded/company logo. */
function workspaceInitials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return "W";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function WorkspaceMonogram({ name, size }: { name: string; size: number }) {
  const initials = workspaceInitials(resolveWorkspaceName(name) || name || "Workspace");
  return (
    <span
      aria-hidden="true"
      className="shrink-0 inline-flex items-center justify-center rounded-[var(--radius-button)] bg-[var(--bg-2)] text-[var(--ink-soft)] font-medium select-none"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initials}
    </span>
  );
}
