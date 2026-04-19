/**
 * SectionEyebrow — tiny mono uppercase micro-label above a section heading.
 *
 * Matches v11 `section-eyebrow` + v16 `mono-tag` pattern: one short label
 * per section that tells the reader WHO or WHAT the section is about
 * before they read the headline. Dramatically improves scannability.
 *
 * Usage:
 *   <SectionEyebrow>For vibecoders</SectionEyebrow>
 *   <h2>Deploy in minutes.</h2>
 */
import type { ReactNode } from 'react';

interface SectionEyebrowProps {
  children: ReactNode;
  /** Optional testid for e2e. */
  testid?: string;
  /** Accent-tinted eyebrow (emerald) for the "try this" sections. */
  tone?: 'muted' | 'accent';
}

export function SectionEyebrow({ children, testid, tone = 'muted' }: SectionEyebrowProps) {
  const color = tone === 'accent' ? 'var(--accent)' : 'var(--muted)';
  return (
    <div
      data-testid={testid}
      style={{
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 11,
        fontWeight: 600,
        color,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        marginBottom: 12,
        lineHeight: 1.2,
      }}
    >
      {children}
    </div>
  );
}
