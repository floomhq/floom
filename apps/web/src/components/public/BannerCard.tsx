// BannerCard — small mono-text "run-state" preview that sits inside an
// app card's thumb area. Pattern from v23 wireframe (Delta 12,
// Federico-locked 2026-04-25): "show the result of running the app,
// not the app identity." Each card renders 1 title + 1-4 lines, with
// optional `accent` (brand-green) and `dim` (muted) line variants.
//
// Used by:
//   - <AppShowcaseRow> for the 3 launch hero cards (large size).
//   - <AppGrid> browse-row cards for the utility apps (small size).
//
// NO CATEGORY TINTS. Federico locked a single neutral palette
// 2026-04-26 morning: the v23 wireframe's mint/yellow/sky/stone tints
// are explicitly overridden. All banners share the same warm-light
// neutral surface so the directory reads as one restrained palette.
//
// We keep the wireframe's typographic + structural pattern (mono title,
// banner lines, accent/dim modifiers) but pin the surface to a single
// token. The category signal moves entirely to the small text cap on
// the card footer/thumb chip — color does not have to do that work.
import type { CSSProperties } from 'react';

export interface BannerLine {
  text: string;
  /** brand-green accent line — mirrors `.banner-line.accent` in wireframe */
  accent?: boolean;
  /** muted dim line — mirrors `.banner-line.dim` in wireframe */
  dim?: boolean;
}

export type BannerCardSize = 'sm' | 'lg';

interface BannerCardProps {
  /** Mono uppercase header label (e.g. "competitor-lens"). */
  title: string;
  /** 1-4 result lines. Each line wraps to a single row. */
  lines: BannerLine[];
  /**
   * Visual size:
   *  - "lg": showcase hero cards (10px title, 12px lines, generous padding)
   *  - "sm": browse-row utility cards (9px title, 10.5px lines, tighter)
   */
  size?: BannerCardSize;
}

// Single neutral surface for ALL banner cards (no category tints).
const BANNER_SURFACE = 'rgba(255, 255, 255, 0.92)';
const BANNER_BORDER = 'rgba(15, 23, 42, 0.06)';
const BANNER_INK = '#1b1a17';
const BANNER_DIM = 'rgba(14, 14, 12, 0.5)';
// Brand green is the only accent color anywhere on the card surface —
// matches `var(--accent)` token used across the rest of the app.
const BANNER_ACCENT = 'var(--accent, #047857)';

export function BannerCard({ title, lines, size = 'sm' }: BannerCardProps) {
  const isLarge = size === 'lg';
  const titleSize = isLarge ? 10 : 9;
  const lineSize = isLarge ? 12 : 10.5;
  const lineHeight = isLarge ? 1.55 : 1.5;
  const padY = isLarge ? 11 : 8;
  const padX = isLarge ? 14 : 12;
  const minWidth = isLarge ? 160 : 140;

  const containerStyle: CSSProperties = {
    background: BANNER_SURFACE,
    border: `1px solid ${BANNER_BORDER}`,
    borderRadius: 8,
    padding: `${padY}px ${padX}px`,
    minWidth,
    maxWidth: '90%',
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    color: BANNER_INK,
  };

  const titleStyle: CSSProperties = {
    fontSize: titleSize,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: BANNER_DIM,
    marginBottom: 4,
    lineHeight: 1.2,
  };

  const baseLineStyle: CSSProperties = {
    display: 'block',
    fontSize: lineSize,
    lineHeight,
    color: BANNER_INK,
    fontWeight: 500,
    // Stat-line nowrap fix (decision doc PORT #6): banner-card lines
    // shouldn't break across 2 lines mid-string.
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  return (
    <div aria-hidden="true" style={containerStyle} data-testid="banner-card">
      <span style={titleStyle}>{title}</span>
      {lines.map((line, i) => {
        const style: CSSProperties = { ...baseLineStyle };
        if (line.accent) {
          style.color = BANNER_ACCENT;
          style.fontWeight = 600;
        } else if (line.dim) {
          style.color = BANNER_DIM;
        }
        return (
          <span key={i} style={style}>
            {line.text}
          </span>
        );
      })}
    </div>
  );
}
