// WorkerOS identity-mark generator — locked design system.
// SPEC: /root/workeros-design-baseline/SPEC.md (panel-scored, locked 2026-06-22).
//
// Deterministic, SSR-safe (pure, no DOM / no random / no useEffect). The same
// seed always yields the same mark. Ported verbatim from the approved
// reference generator in user-workspace-generator.html (v3).
//
// Hard rules (founder, do NOT reintroduce): NEVER letters/initials. No
// gradients. No human faces. No stock glyphs (radar/orbit/star/sparkle). A
// restrained COOL palette only — two cohesive blue tones per mark on a neutral
// ground. Earlier rainbow-gradient/marble generators were explicitly rejected
// as AI-slop and off design-system.

/** Neutral ground behind every generated mark (= --bg-2 token value). */
export const MARK_GROUND = "#F3F4F6";

/**
 * Five cohesive two-blue tone pairs (primary, light). Restrained cool palette;
 * no rainbow, no warm hues. Order is part of the deterministic contract — do
 * not reorder without re-baselining the marks.
 */
export const MARK_PAIRS: readonly (readonly [string, string])[] = [
  ["#3E6FE0", "#9DB6F2"],
  ["#2F5FC8", "#A7C0EF"],
  ["#5566A8", "#B9C6EE"],
  ["#3E6FE0", "#A7C0EF"],
  ["#2F5FC8", "#9DB6F2"],
];

/** Number of motifs — matches MOTIFS length; the hash is taken mod this. */
export const MARK_MOTIF_COUNT = 6;

/**
 * FNV-1a 32-bit hash (matches the reference `hash(s)`), returns a non-negative
 * integer deterministically from `s`.
 */
export function markHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export type MarkMotif =
  | "concentric"
  | "cross"
  | "split"
  | "twin"
  | "square-disc"
  | "stacked-bars";

const MOTIF_NAMES: readonly MarkMotif[] = [
  "concentric",
  "cross",
  "split",
  "twin",
  "square-disc",
  "stacked-bars",
];

export interface GeneratedMark {
  /** Selected motif name (one of 6 chunky, centered, orthogonal shapes). */
  motif: MarkMotif;
  /** Motif index 0..5. */
  motifIndex: number;
  /** Primary (darker) tone. */
  c1: string;
  /** Secondary (lighter) tone. */
  c2: string;
}

/**
 * Deterministically derive the motif + tone pair for a seed. Pure — safe to
 * call during SSR and in tests.
 */
export function generateMark(seed: string): GeneratedMark {
  const h = markHash(seed);
  const motifIndex = h % MARK_MOTIF_COUNT;
  const [c1, c2] = MARK_PAIRS[(h >> 5) % MARK_PAIRS.length];
  return { motif: MOTIF_NAMES[motifIndex], motifIndex, c1, c2 };
}
