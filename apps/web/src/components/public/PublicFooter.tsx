import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { readDeployEnabled } from '../../lib/flags';
import { waitlistHref } from '../../lib/waitlistCta';

function IconDiscordFooter() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.001.022.015.043.033.055a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

function IconGitHubFooter() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function IconXFooter() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const SOCIAL_ICON_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 40,
  height: 40,
  borderRadius: 10,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  color: 'var(--muted)',
  textDecoration: 'none',
  transition: 'color 0.15s, border-color 0.15s, background 0.15s',
};

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
          gridTemplateColumns: 'repeat(3, minmax(120px, 1fr))',
          gap: 20,
          maxWidth: 560,
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

      {/* Bottom row: social icons + tagline + copyright */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}
      >
        {/* Tagline above icons */}
        <div
          data-testid="footer-tagline"
          style={{
            fontSize: 12.5,
            color: 'var(--muted)',
            letterSpacing: '0.02em',
          }}
        >
          Building Floom in Hamburg + SF · Backed by{' '}
          <a
            href="https://f.inc"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--ink)', fontWeight: 600, textDecoration: 'none', borderBottom: '1px solid var(--line)' }}
          >
            Founders Inc
          </a>
        </div>

        {/* Social icons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <a
            href="https://discord.gg/floom"
            target="_blank"
            rel="noreferrer"
            aria-label="Discord"
            style={SOCIAL_ICON_STYLE}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.color = '#5865F2';
              el.style.borderColor = '#5865F2';
              el.style.background = 'rgba(88,101,242,0.06)';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.color = 'var(--muted)';
              el.style.borderColor = 'var(--line)';
              el.style.background = 'var(--bg)';
            }}
          >
            <IconDiscordFooter />
          </a>
          <a
            href="https://github.com/floomhq/floom"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            style={SOCIAL_ICON_STYLE}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.color = '#181717';
              el.style.borderColor = '#181717';
              el.style.background = 'rgba(24,23,23,0.06)';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.color = 'var(--muted)';
              el.style.borderColor = 'var(--line)';
              el.style.background = 'var(--bg)';
            }}
          >
            <IconGitHubFooter />
          </a>
          <a
            href="https://x.com/floomhq"
            target="_blank"
            rel="noreferrer"
            aria-label="X / Twitter"
            style={SOCIAL_ICON_STYLE}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.color = '#000000';
              el.style.borderColor = '#000000';
              el.style.background = 'rgba(0,0,0,0.06)';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.color = 'var(--muted)';
              el.style.borderColor = 'var(--line)';
              el.style.background = 'var(--bg)';
            }}
          >
            <IconXFooter />
          </a>
        </div>

        {/* Separator + copyright */}
        <div
          style={{
            width: '100%',
            maxWidth: 280,
            borderTop: '1px solid var(--line)',
            paddingTop: 12,
            textAlign: 'center',
          }}
        >
          <div
            data-testid="footer-copyright"
            style={{ fontSize: 12, color: 'var(--muted)' }}
          >
            © 2026 Floom. Hamburg + SF.
          </div>
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
