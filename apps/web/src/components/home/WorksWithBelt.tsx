/**
 * WorksWithBelt — v17 landing · "Works with" row that sits directly under
 * the hero CTAs. Six explicit clients with real brand-mark SVGs.
 *
 * Source of truth: /var/www/wireframes-floom/v17/landing.html (hero-works-with
 * block), and REVISION-2026-04-22.md Fix 5 / Fix 7 which locked the six
 * items and their placement (right under CTAs, above the Lead Scorer demo).
 *
 * Logo sourcing rule (MEMORY.md): SimpleIcons paths where available,
 * restrained geometric glyphs otherwise. No text-in-circles. No emojis.
 */
import type { CSSProperties, ReactNode } from 'react';

interface Item {
  label: string;
  mark: ReactNode;
}

const ITEMS: Item[] = [
  {
    label: 'Claude Desktop',
    // Anthropic brand mark (simpleicons `anthropic`) trimmed to the
    // ideogram. Stroke rather than fill so the belt stays monochrome and
    // inherits --muted like the rest of the row.
    mark: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
        <path d="M13.827 3.52h3.603L24 20.477h-3.603l-6.57-16.957zm-7.258 0h3.767L16.906 20.477h-3.674l-1.343-3.461H5.017l-1.344 3.461H0L6.57 3.52zm4.132 10.532L8.453 7.392l-2.248 6.66h4.496z"/>
      </svg>
    ),
  },
  {
    label: 'Claude Code',
    // Terminal-prompt chevron — same shape the Claude Code CLI uses in
    // its own marketing. Stroke-only, no fills, stays on the muted row.
    mark: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    ),
  },
  {
    label: 'Cursor',
    // Cursor brand glyph — the diamond-C mark is the published logo.
    mark: (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M11.925 24l10.425-6.01V5.98L11.925 0 1.5 5.98v12.01L11.925 24zm0-2.32l-8.4-4.85V7.17l8.4 4.86v9.65zm.9-9.65l8.4-4.86v9.66l-8.4 4.85v-9.65zm-.45-1.56L3.975 5.63l8.4-4.85 8.4 4.85-8.4 4.84z"
        />
      </svg>
    ),
  },
  {
    label: 'ChatGPT',
    // OpenAI `simpleicons` path. Fill = currentColor so the row stays
    // tonally consistent.
    mark: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
      </svg>
    ),
  },
  {
    label: 'Codex CLI',
    // Angle-brackets glyph evokes a CLI; OpenAI Codex has no dedicated
    // brand mark we can use without misrepresenting, so we stay in the
    // geometric vocabulary.
    mark: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
  {
    label: 'Any MCP client',
    // MCP has no finalised public logo; a dashed protocol-ring + center
    // dot is the glyph the wireframe uses. Keeps us honest about the
    // "any" framing.
    mark: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4l3 2" />
      </svg>
    ),
  },
];

const EYEBROW_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  color: 'var(--muted)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
  textAlign: 'center',
  marginBottom: 12,
};

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'center',
  alignItems: 'center',
  gap: '18px 40px',
  padding: '6px 0 0',
  margin: '0 auto',
  maxWidth: 820,
};

const ITEM_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 14,
  color: 'var(--muted)',
  fontWeight: 500,
  opacity: 0.9,
};

export function WorksWithBelt() {
  return (
    <div
      data-testid="works-with-belt"
      style={{
        maxWidth: 920,
        margin: '28px auto 0',
        padding: '0 12px',
      }}
    >
      <div style={EYEBROW_STYLE}>Works with</div>
      <div className="works-with" style={ROW_STYLE}>
        {ITEMS.map((item) => (
          <span key={item.label} className="ww-item" style={ITEM_STYLE}>
            <span
              aria-hidden="true"
              style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--muted)' }}
            >
              {item.mark}
            </span>
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
