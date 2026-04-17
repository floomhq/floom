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
}

// Deterministic color palette so every app gets a calm, readable
// tinted icon square without hand-picking per slug. Matches the
// warm/soft hues from the v15 wireframe (indigo, amber, pink, emerald,
// blue, slate, red, purple, sky).
const PALETTE = [
  { bg: '#eef2ff', fg: '#4338ca' }, // indigo
  { bg: '#fef3c7', fg: '#92400e' }, // amber
  { bg: '#fce7f3', fg: '#9d174d' }, // pink
  { bg: '#ecfdf5', fg: '#047857' }, // emerald
  { bg: '#dbeafe', fg: '#1d4ed8' }, // blue
  { bg: '#f1f5f9', fg: '#0f172a' }, // slate
  { bg: '#fef2f2', fg: '#b91c1c' }, // red
  { bg: '#f3e8ff', fg: '#7c3aed' }, // purple
  { bg: '#f0f9ff', fg: '#0284c7' }, // sky
  { bg: '#f5f5f4', fg: '#44403c' }, // stone
] as const;

function paletteFor(slug: string): (typeof PALETTE)[number] {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function AppStripe({ slug, name, description, meta, variant = 'landing' }: AppStripeProps) {
  const color = paletteFor(slug);
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
