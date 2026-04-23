import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { AppIcon } from '../AppIcon';
import { DescriptionMarkdown } from '../DescriptionMarkdown';
import { categoryTint } from '../../lib/categoryTint';

interface AppStripeProps {
  slug: string;
  name: string;
  description: string;
  /** Optional per-row meta (e.g. run count) shown on the right before the arrow. */
  meta?: string;
  /** Variant changes spacing & font sizes. Default = landing (roomier). */
  variant?: 'landing' | 'apps';
  /** Category hint for glyph tile tint (#91). */
  category?: string;
}

export function AppStripe({ slug, name, description, meta, variant = 'landing', category }: AppStripeProps) {
  const tint = categoryTint(category ?? null);
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
          background: tint.bg,
          color: tint.fg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxShadow: 'inset 0 0 0 1px rgba(15, 23, 42, 0.06)',
        }}
      >
        <AppIcon slug={slug} size={innerIcon} color={tint.fg} />
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
          <DescriptionMarkdown
            description={description}
            testId={`app-stripe-desc-${slug}`}
            style={{
              margin: 0,
              maxWidth: 'none',
              fontSize: 'inherit',
              lineHeight: 'inherit',
              color: 'inherit',
            }}
          />
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
