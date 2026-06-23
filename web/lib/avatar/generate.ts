// WorkerOS identity-mark generator — locked design system.
// SPEC: /root/workeros-design-baseline/SPEC.md (panel-scored, locked 2026-06-22).
//
// Deterministic, SSR-safe (pure, no DOM / no random / no useEffect). The same
// seed always yields the same mark. Ported verbatim from the approved
// reference generator in user-workspace-generator.html (v3).
//
// Hard rules (founder, do NOT reintroduce): NEVER letters/initials. No
// gradients. No human faces. No stock glyphs (radar/orbit/star/sparkle).
// Role drives BOTH shape AND color family:
//   user      -> circle + NEUTRAL GRAPHITE palette (human entity)
//   workspace -> squircle + ACCENT BLUE palette (workspace entity)
//   worker    -> squircle + ACCENT BLUE palette (non-human entity)
// Earlier rainbow-gradient/marble generators were explicitly rejected as
// AI-slop and off design-system.

/** Neutral ground behind every generated mark (= --bg-2 token value). */
export const MARK_GROUND = "#F3F4F6";

/**
 * ACCENT BLUE pairs — workspace and worker marks. Five cohesive two-blue tone
 * pairs (primary, light). Restrained cool palette; no rainbow, no warm hues.
 * Order is part of the deterministic contract — do not reorder without
 * re-baselining the marks.
 */
export const MARK_PAIRS: readonly (readonly [string, string])[] = [
  ["#3E6FE0", "#9DB6F2"],
  ["#2F5FC8", "#A7C0EF"],
  ["#5566A8", "#B9C6EE"],
  ["#3E6FE0", "#A7C0EF"],
  ["#2F5FC8", "#9DB6F2"],
];

/**
 * NEUTRAL GRAPHITE pairs — user marks only. Distinct from accent-blue so a
 * user and any workspace are visually distinguishable even when they share the
 * same motif shape. Five graphite tone pairs (darker, lighter).
 */
export const USER_MARK_PAIRS: readonly (readonly [string, string])[] = [
  ["#3a3f4b", "#9aa1ad"],
  ["#4a5060", "#a8afbb"],
  ["#525869", "#b0b7c3"],
  ["#3f4452", "#959ca8"],
  ["#464c5c", "#9da4b0"],
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
 * Per-role index offsets applied on top of the hash-derived motif index.
 *
 * Design contract:
 * - `user` is the baseline (offset 0).
 * - Every other role has a motif offset that is coprime to MARK_MOTIF_COUNT (6),
 *   guaranteeing that `(h % 6 + motifOffset) % 6` is NEVER equal to `h % 6`
 *   for any h. This makes it IMPOSSIBLE for a user and any other role to share
 *   the same motifIndex when their seeds are identical — without needing the
 *   hash to differ.
 * - Do not reorder or modify these offsets without re-baselining all marks.
 * - Palette is determined by role separately (see generateMarkForRole).
 */
const ROLE_MOTIF_OFFSETS: Record<string, number> = {
  user:      0,
  workspace: 3, // coprime to 6; user motifIndex != workspace motifIndex for any seed
  worker:    1, // coprime to 6
  // emily is fixed (no generated fallback); no offset needed
};

/**
 * Derive the motif + tone pair for a (role, seed) pair. Pure — SSR-safe.
 *
 * Two layers of visual differentiation:
 * 1. MOTIF: role-based index offset ensures user/workspace motifIndex never
 *    collide for the same seed (mathematical guarantee via coprimality).
 * 2. PALETTE: user gets USER_MARK_PAIRS (neutral graphite); workspace/worker
 *    get MARK_PAIRS (accent blue). Color family is always distinguishable by
 *    role — shape alone no longer carries the whole burden.
 *
 * @param role    - "user", "workspace", "worker", or any future role string.
 *                  Emily is handled separately (fixed mark; do not call here).
 * @param rawSeed - Stable database id preferred over display name so the mark
 *                  survives renames. Falls back gracefully to any non-empty string.
 */
export function generateMarkForRole(role: string, rawSeed: string): GeneratedMark {
  const h = markHash(rawSeed);
  const motifOffset = ROLE_MOTIF_OFFSETS[role] ?? 0;
  const motifIndex = (h % MARK_MOTIF_COUNT + motifOffset) % MARK_MOTIF_COUNT;
  // User: graphite palette. Workspace/worker (and any unrecognized role): blue.
  const pairs = role === "user" ? USER_MARK_PAIRS : MARK_PAIRS;
  const [c1, c2] = pairs[(h >> 5) % pairs.length]!;
  return { motif: MOTIF_NAMES[motifIndex]!, motifIndex, c1, c2 };
}

/**
 * @deprecated Prefer `generateMarkForRole(role, seed)` for Avatar rendering
 * so that user and workspace marks never collide for the same seed.
 * This bare-seed variant is kept for backward compat (existing tests, non-avatar
 * usages). It has no role-namespace protection.
 *
 * Deterministically derive the motif + tone pair for a seed. Pure — safe to
 * call during SSR and in tests.
 */
export function generateMark(seed: string): GeneratedMark {
  const h = markHash(seed);
  const motifIndex = h % MARK_MOTIF_COUNT;
  const [c1, c2] = MARK_PAIRS[(h >> 5) % MARK_PAIRS.length]!;
  return { motif: MOTIF_NAMES[motifIndex]!, motifIndex, c1, c2 };
}

/**
 * Convenience: namespace a raw seed by role for use with `generateMark`.
 * Exported for unit tests. `Avatar` uses `generateMarkForRole` directly.
 *
 * @deprecated Use `generateMarkForRole(role, seed)` instead. This helper is
 * kept only for test legibility.
 */
export function namespacedSeed(role: string, rawSeed: string): string {
  return `${role}:${rawSeed}`;
}
