// App glyph tile tint for AppStripe (landing Showcase).
//
// 2026-04-24: collapsed from per-category pastels (green / red / blue /
// pink / amber) to a single neutral tint across every category. The
// landing Showcase rendered three AI apps in three different hues —
// lead-scorer green, resume-screener red/pink, competitor-analyzer
// blue — which fought the page's restrained single-accent palette
// (brand green only). Category identity already reads via the
// eyebrow label + app name; the tinted icon tile was redundant
// signal that broke visual unity. Matches `CARD_NEUTRAL` in
// AppGrid.tsx + `NEUTRAL_PALETTE` in TryTheseApps.tsx: warm dark
// ink on a warm light neutral band.
//
// Function + type signatures kept stable so call-sites (AppStripe)
// don't need to change. If we ever re-introduce category tints,
// this is where to wire them back.

export type CategoryTint = { bg: string; fg: string };

const NEUTRAL: CategoryTint = { bg: '#f5f5f3', fg: '#1b1a17' };

export function categoryTint(_category: string | null | undefined): CategoryTint {
  return NEUTRAL;
}
