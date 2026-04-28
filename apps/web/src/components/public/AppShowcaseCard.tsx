import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { AppIcon } from '../AppIcon';
import { DescriptionMarkdown } from '../DescriptionMarkdown';
import { categoryTint } from '../../lib/categoryTint';

interface AppShowcaseCardProps {
  slug: string;
  name: string;
  description: string;
  category?: string;
}

/**
 * G3 (2026-04-28): app-store-style card for landing showcase.
 * Federico: "the apps on the landing page should be cards, like on the
 * app store. Right now they are just small boxes."
 *
 * Replaces the horizontal AppStripe layout (icon left, text middle,
 * arrow right). New format: vertical card with prominent icon tile,
 * bold name, tagline, category pill + Try CTA pinned to the bottom.
 * Designed to be 3-up at desktop, 2-up at tablet, 1-up at mobile via
 * the parent grid.
 */
export function AppShowcaseCard({ slug, name, description, category }: AppShowcaseCardProps) {
  const tint = categoryTint(category ?? null);

  return (
    <Link
      to={`/p/${slug}`}
      data-testid={`app-stripe-${slug}`}
      className="app-showcase-card-link"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: '24px 22px 20px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 16,
        color: 'inherit',
        textDecoration: 'none',
        transition: 'border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease',
        boxShadow: '0 1px 2px rgba(22,21,18,0.04)',
        minHeight: 200,
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--ink)';
        el.style.transform = 'translateY(-2px)';
        el.style.boxShadow = '0 4px 16px rgba(22,21,18,0.08)';
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--line)';
        el.style.transform = 'translateY(0)';
        el.style.boxShadow = '0 1px 2px rgba(22,21,18,0.04)';
      }}
    >
      {/* Top row: icon tile (app-store style — bigger, square-ish) */}
      <span
        aria-hidden="true"
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          background: tint.bg,
          color: tint.fg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxShadow: 'inset 0 0 0 1px rgba(15, 23, 42, 0.06)',
        }}
      >
        <AppIcon slug={slug} size={28} color={tint.fg} />
      </span>

      {/* Title + tagline */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div
          style={{
            fontSize: 17,
            fontWeight: 700,
            color: 'var(--ink)',
            lineHeight: 1.25,
            letterSpacing: '-0.01em',
          }}
        >
          {name}
        </div>
        <div
          style={{
            fontSize: 13.5,
            color: 'var(--muted)',
            lineHeight: 1.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 3,
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

      {/* Bottom row: category pill + Try CTA */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          marginTop: 'auto',
          paddingTop: 4,
        }}
      >
        {category ? (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '3px 9px',
              borderRadius: 999,
              border: '1px solid var(--line)',
              color: 'var(--muted)',
              background: 'var(--bg)',
              letterSpacing: '0.02em',
              textTransform: 'lowercase',
            }}
          >
            {category}
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--accent)',
          }}
        >
          Try it
          <ArrowRight size={14} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}
