// Deterministic workspace monogram: a seeded 2-stop gradient + initials.
//
// Given a workspace id (or name as fallback), produces a stable pair of muted
// CSS gradient-stop strings. The palette is curated to stay within brand
// (muted blues, slates, sage-greens, warm greys) — no garish hues. Output is
// always legible white initials on top.

const PALETTE: [string, string][] = [
  // [stop-0, stop-1] — all values intentionally muted / mid-chroma
  ["#4A6FA5", "#2D4E7E"], // steel blue
  ["#3D7D6C", "#275949"], // sage green
  ["#5B6FA8", "#3A4E82"], // indigo-slate
  ["#6B7FA0", "#48597A"], // slate blue
  ["#5E7A8A", "#3B5565"], // teal-grey
  ["#7A7099", "#53496E"], // muted violet
  ["#4E7A6B", "#2F5549"], // deep sage
  ["#5B799E", "#38567A"], // dusty blue
  ["#6B8B7A", "#436356"], // muted green-grey
  ["#5C6B8A", "#384463"], // navy slate
  ["#7A6B8A", "#53456A"], // plum-grey
  ["#4A7A7A", "#2D5555"], // teal
  ["#6E7A5A", "#4A5538"], // olive-grey
  ["#5A6E8A", "#384963"], // blue-grey
  ["#8A7A6B", "#625340"], // warm taupe
  ["#5A7A8A", "#385563"], // cool teal-blue
];

/** djb2 hash — stable, no BigInt, no crypto. */
function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    // Truncate to 32-bit without BigInt using signed shift semantics.
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export interface WorkspaceMonogram {
  /** CSS linear-gradient string for the squircle background. */
  gradient: string;
  /** 2-char initials (uppercase). */
  initials: string;
}

/**
 * Returns a deterministic gradient + initials for a workspace.
 * Seed priority: id (stable) > name (fallback when id absent).
 */
export function workspaceMonogram(id: string, name: string): WorkspaceMonogram {
  const seed = id || name || "?";
  const [stop0, stop1] = PALETTE[djb2(seed) % PALETTE.length];
  const gradient = `linear-gradient(135deg, ${stop0} 0%, ${stop1} 100%)`;

  const display = name.trim();
  const initials = display ? display.slice(0, 2).toUpperCase() : "?";

  return { gradient, initials };
}
