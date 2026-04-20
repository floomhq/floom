import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { AppIcon } from '../AppIcon';

interface AppStripeProps {
  slug: string;
  name: string;
  description: string;
  /** Optional per-row meta (e.g. run count) shown on the right before the arrow. */
  meta?: string;
  /** Variant changes spacing & font sizes. Default = landing (roomier). */
  variant?: 'landing' | 'apps';
  /**
   * Rescue 2026-04-21 (Fix 4): category hint for the icon-tile tint.
   * When present, AppStripe picks a category-appropriate palette so
   * the /apps grid has rhythm instead of 55 identical emerald squares.
   * Still restrained: three soft tints total (emerald / amber / slate)
   * mapped from manifest categories. Falls back to emerald when
   * missing (landing page hero tiles stay green by default).
   */
  category?: string;
}

/**
 * Rescue 2026-04-21 (Fix 4): category-based icon tile tints.
 *
 * Why: when every app icon is the same glyph style on the same
 * emerald tile, visually they read as AI-slop fill. Federico's audit:
 * "when every icon is an identical-style glyph on an identical
 * emerald-tint tile at identical size, visually they read as
 * AI-generated fill. Zero identity per app."
 *
 * Why not per-slug: we'd be back to the banned 10-color palette that
 * violated "max 1-2 accent colors" (2026-04-18 audit). Category
 * gives three stable buckets that carry semantic weight too — a
 * creator browsing "developer" sees green, an analyst scanning
 * "data" sees slate. Still restrained.
 *
 * Mapping:
 *   emerald  — Floom native (dev-utility, productivity, writing, AI apps we built)
 *   amber    — "make / create / generate" AI apps (research, marketing, design, text)
 *   slate    — third-party data & API integrations (open_data, financial, location, etc.)
 */
interface Tint {
  bg: string;
  fg: string;
}
const TINT_EMERALD: Tint = { bg: '#ecfdf5', fg: '#047857' };
const TINT_AMBER: Tint = { bg: '#fffaf0', fg: '#b45309' };
const TINT_SLATE: Tint = { bg: '#f1f5f9', fg: '#475569' };

const CATEGORY_TINT: Record<string, Tint> = {
  // Floom-native / creator-tools -> emerald (stays with the brand accent)
  'developer-tools': TINT_EMERALD,
  'developer_tools': TINT_EMERALD,
  developer: TINT_EMERALD,
  productivity: TINT_EMERALD,
  // AI generation / creative output -> warm amber
  ai: TINT_AMBER,
  research: TINT_AMBER,
  marketing: TINT_AMBER,
  design: TINT_AMBER,
  writing: TINT_AMBER,
  text: TINT_AMBER,
  seo: TINT_AMBER,
  analytics: TINT_AMBER,
  // Data / third-party APIs -> cool slate
  open_data: TINT_SLATE,
  'open-data': TINT_SLATE,
  location: TINT_SLATE,
  financial: TINT_SLATE,
  media: TINT_SLATE,
  ecommerce: TINT_SLATE,
  messaging: TINT_SLATE,
  travel: TINT_SLATE,
};

function paletteFor(category?: string): Tint {
  if (!category) return TINT_EMERALD;
  return CATEGORY_TINT[category] || TINT_EMERALD;
}

export function AppStripe({ slug, name, description, meta, variant = 'landing', category }: AppStripeProps) {
  const color = paletteFor(category);
  const iconSize = variant === 'landing' ? 44 : 42;
  const innerIcon = variant === 'landing' ? 22 : 20;

  return (
    <Link
      to={`/p/${slug}`}
      data-testid={`app-stripe-${slug}`}
      className="app-stripe-link"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: variant === 'landing' ? '22px 24px' : '20px 22px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        color: 'inherit',
        textDecoration: 'none',
        transition: 'border-color 140ms ease, transform 140ms ease',
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--ink)';
        el.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--line)';
        el.style.transform = 'translateY(0)';
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: iconSize,
          height: iconSize,
          borderRadius: 12,
          background: color.bg,
          color: color.fg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <AppIcon slug={slug} size={innerIcon} color={color.fg} />
      </span>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: variant === 'landing' ? 17 : 16,
            fontWeight: 600,
            color: 'var(--ink)',
            lineHeight: 1.3,
          }}
        >
          {name}
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: variant === 'landing' ? 14.5 : 13.5,
            color: 'var(--muted)',
            lineHeight: 1.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {description}
        </div>
      </div>

      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          color: 'var(--muted)',
          fontSize: 13,
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        {meta && <span>{meta}</span>}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {variant === 'landing' && <span>Try</span>}
          <ArrowRight size={16} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}
