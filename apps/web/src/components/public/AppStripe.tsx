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

// Landing visual audit 2026-04-18 finding: the previous 10-color palette
// (indigo / purple / pink / red / amber / ...) violated the "max 1-2 accent
// colors" design bar and reintroduced a purple (#7c3aed) after purple was
// banned earlier. Collapsed to a single emerald tint so every app icon
// reads as part of Floom's green accent system instead of a rainbow.
const APP_TINT = { bg: '#ecfdf5', fg: '#047857' } as const;

function paletteFor(_slug: string): typeof APP_TINT {
  return APP_TINT;
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
