import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { readDeployEnabled } from '../../lib/flags';
import { waitlistHref } from '../../lib/waitlistCta';

// 2026-04-24 restructure: footer grouped into 3 labelled columns
// (Product / Company / Legal) instead of the old 13-link "pipe soup"
// strip. The pipe-separated row was the audit's "pipe soup" flag: hard
// to scan, links blurred together, no grouping signal. Three stacked
// columns is the pattern every serious OSS company uses (Vercel,
// Linear, Figma) and it stays compact on desktop while collapsing to a
// single column on mobile.
//
// Link inventory unchanged — same routes, same external github link —
// only the visual grouping changed. Both /imprint and /legal still
// resolve to the same page for bookmark back-compat.
//
// 2026-04-20 (about-page ship): added a one-line identity strip above
// the link row — preserved here as the "Ship AI apps fast." tagline
// that mirrors the current landing H1.
//
// V26 (2026-04-27): slim 3-col footer per Federico's feedback.
//   Product: Apps · Docs · Pricing · Changelog
//   Company: About · GitHub · Status
//   Legal: Terms · Privacy
// Removed: Cookies (covered by Privacy), Legal (Terms covers it),
//   Runtime limits + Security (moved to Docs). Removed "Built in SF"
//   tagline (X1: misleading, Federico in Hamburg moving to SF).

const COL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  alignItems: 'flex-start',
  minWidth: 120,
};

const COL_LABEL_STYLE: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontWeight: 600,
  color: 'var(--ink)',
  marginBottom: 4,
};

const LINK_STYLE: React.CSSProperties = {
  color: 'var(--muted)',
  textDecoration: 'none',
  fontSize: 13,
  lineHeight: 1.4,
};

function FootLink({ children, to, href }: { children: React.ReactNode; to?: string; href?: string }) {
  const common = {
    style: LINK_STYLE,
    onMouseEnter: (e: React.MouseEvent<HTMLAnchorElement>) => {
      (e.currentTarget as HTMLAnchorElement).style.color = 'var(--ink)';
    },
    onMouseLeave: (e: React.MouseEvent<HTMLAnchorElement>) => {
      (e.currentTarget as HTMLAnchorElement).style.color = 'var(--muted)';
    },
  };
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" {...common}>{children}</a>
  ) : (
    <Link to={to!} {...common}>{children}</Link>
  );
}

export function PublicFooter() {
  const deployEnabled = useMemo(() => readDeployEnabled(), []);

  return (
    <footer
      data-testid="public-footer"
      style={{
        padding: '36px 24px 32px',
        background: 'var(--card)',
        borderTop: '1px solid var(--line)',
      }}
    >
      {/* 3-column link grid — centred block, left-aligned columns. */}
      <div
        data-testid="footer-columns"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(140px, 1fr))',
          gap: 32,
          maxWidth: 640,
          margin: '0 auto 28px',
          textAlign: 'left',
        }}
        className="public-footer-columns"
      >
        <div style={COL_STYLE}>
          <div style={COL_LABEL_STYLE}>Product</div>
          <FootLink to="/apps">Apps</FootLink>
          <FootLink to="/docs">Docs</FootLink>
          <FootLink to="/pricing">Pricing</FootLink>
          <FootLink to="/changelog">Changelog</FootLink>
        </div>

        <div style={COL_STYLE}>
          <div style={COL_LABEL_STYLE}>Company</div>
          <FootLink to="/about">About</FootLink>
          <FootLink href="https://github.com/floomhq/floom">GitHub</FootLink>
          <FootLink to="/status">Status</FootLink>
        </div>

        <div style={COL_STYLE}>
          <div style={COL_LABEL_STYLE}>Legal</div>
          <FootLink to="/terms">Terms</FootLink>
          <FootLink to="/privacy">Privacy</FootLink>
        </div>
      </div>

      {/* Identity strip + waitlist note — centred bottom row. */}
      <div style={{ textAlign: 'center' }}>
        <div
          data-testid="footer-tagline"
          style={{
            fontSize: 12,
            color: 'var(--muted)',
            letterSpacing: '0.01em',
            margin: '0 0 6px',
          }}
        >
          Ship AI apps fast.
        </div>
        {!deployEnabled && (
          <div
            data-testid="footer-waitlist-strip"
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              margin: '0',
              lineHeight: 1.5,
            }}
          >
            Publishing new apps on floom.dev is waitlist-only.{' '}
            <Link
              to={waitlistHref('public-footer')}
              style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
            >
              Join the waitlist
            </Link>
          </div>
        )}
      </div>
    </footer>
  );
}
