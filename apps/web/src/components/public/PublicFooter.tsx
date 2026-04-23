import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { readDeployEnabled } from '../../lib/flags';
import { waitlistHref } from '../../lib/waitlistCta';

// Landing visual audit 2026-04-18 finding: PublicFooter only had Docs +
// Imprint, so cold public visitors from HN/PH had no path to Privacy,
// Terms, Cookies, or the open-source GitHub repo: major trust + EU
// compliance gap. Expanded to match the signed-in Footer.tsx link set
// while keeping the landing's centered, muted, one-line rhythm.
//
// 2026-04-20: Floom, Inc. is a Delaware C-Corp, not a German sole
// proprietorship. Renamed the "Imprint" link to "Legal" — the /imprint
// route still resolves (back-compat for bookmarks and sitemaps), and
// /legal is added as an alias so either URL hits the same page.
//
// 2026-04-20 (about-page ship): added a one-line identity strip above
// the link row — "Get that thing off localhost fast." This is the About
// page H1 and pulls double-duty here as the site-wide tagline. Muted,
// centered to match the existing rhythm. Also wired an "About" link into
// the link row (new page, supersedes the old `/about` → `/` redirect).
const LINK_STYLE: React.CSSProperties = { color: 'var(--muted)', textDecoration: 'none' };

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
        padding: '24px 24px 28px',
        textAlign: 'center',
        background: 'var(--card)',
        borderTop: '1px solid var(--line)',
      }}
    >
      {/* Identity strip: tagline double-duty with the About page H1. */}
      <div
        data-testid="footer-tagline"
        style={{
          fontSize: 12,
          color: 'var(--muted)',
          letterSpacing: '0.01em',
          margin: '0 0 10px',
        }}
      >
        Get that thing off localhost fast.
      </div>
      {!deployEnabled && (
        <div
          data-testid="footer-waitlist-strip"
          style={{
            fontSize: 12,
            color: 'var(--muted)',
            margin: '0 0 12px',
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
          {/* TODO(Agent 9): swap Link for WaitlistModal trigger. */}
        </div>
      )}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          columnGap: 16,
          rowGap: 8,
          fontSize: 13,
          color: 'var(--muted)',
          flexWrap: 'wrap',
        }}
      >
        <span>Built in SF</span>
        <span aria-hidden="true">·</span>
        <FootLink to="/about">About</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/pricing">Pricing</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/docs">Docs</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/changelog">Changelog</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/docs/limits">Runtime limits</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/docs/security">Security</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink href="https://github.com/floomhq/floom">GitHub</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/legal">Legal</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/privacy">Privacy</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/terms">Terms</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/cookies">Cookies</FootLink>
      </div>
    </footer>
  );
}
