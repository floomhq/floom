import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { PageHead } from '../components/PageHead';
import { PublicFooter } from '../components/public/PublicFooter';
import { readDeployEnabled } from '../lib/flags';

/**
 * Imperatively append a `<meta name="robots" content="noindex,nofollow">`
 * tag to document.head when the NotFoundPage mounts, and remove it on
 * unmount. We can't change the server response status from a SPA route
 * (that needs SSR), but the noindex meta keeps Googlebot / Bingbot from
 * treating soft-404s as real pages in the index.
 *
 * A helmet library would be cleaner, but react-helmet-async is not a
 * dep here and the whole behavior is ~15 lines. Uses a data-* marker
 * so we don't duplicate the tag on StrictMode double-mounts.
 */
function useNoIndexMeta() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const MARKER = 'data-floom-notfound-robots';
    // If a marker already exists (StrictMode double-effect), reuse it.
    let tag = document.head.querySelector(
      `meta[${MARKER}]`,
    ) as HTMLMetaElement | null;
    if (!tag) {
      tag = document.createElement('meta');
      tag.setAttribute('name', 'robots');
      tag.setAttribute('content', 'noindex,nofollow');
      tag.setAttribute(MARKER, '1');
      document.head.appendChild(tag);
    }
    return () => {
      // Remove only the tag we added. Leave any unrelated robots meta alone.
      const existing = document.head.querySelector(
        `meta[${MARKER}]`,
      );
      if (existing) existing.remove();
    };
  }, []);
}

// Popular-links grid per wireframes/v17/404.html. Wireframe mockup lists
// app names (Lead Scorer, Competitor Analyzer, etc.), but the task spec
// for this PR specifies six navigation destinations — home, apps directory,
// docs, build, me, login. Keeping navigation destinations (not specific
// app slugs) avoids the card going stale when the catalogue changes, and
// matches the "real catalogue" spirit of the wireframe note more honestly
// than hard-coding three slugs.
//
// Icons are monochrome SVGs on a neutral chip background. Stroke-based so
// they inherit `color: var(--ink)` from the chip — same visual language
// as /apps and /me cards.
type PopLink = {
  to: string;
  title: string;
  path: string;
  icon: JSX.Element;
};

const POPULAR_LINKS: PopLink[] = [
  {
    to: '/',
    title: 'Home',
    path: '/',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M3 12 L12 3 L21 12" />
        <path d="M5 10 v10 a2 2 0 0 0 2 2 h10 a2 2 0 0 0 2 -2 v-10" />
      </svg>
    ),
  },
  {
    to: '/apps',
    title: 'Apps directory',
    path: '/apps',
    icon: (
      <svg viewBox="0 0 24 24">
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
      </svg>
    ),
  },
  {
    to: '/docs',
    title: 'Docs',
    path: '/docs',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M4 19.5 v-15 A2.5 2.5 0 0 1 6.5 2 H20 v20 H6.5 a2.5 2.5 0 0 1 0 -5 H20" />
      </svg>
    ),
  },
  {
    to: '/studio/build',
    title: 'Build an app',
    path: '/studio/build',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M14 2 v6 h6" />
        <path d="M14 2 H6 a2 2 0 0 0 -2 2 v16 a2 2 0 0 0 2 2 h12 a2 2 0 0 0 2 -2 V8 z" />
        <path d="M9 14 l2 2 l4 -4" />
      </svg>
    ),
  },
  {
    to: '/me',
    title: 'Your dashboard',
    path: '/me',
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21 v-1 a7 7 0 0 1 16 0 v1" />
      </svg>
    ),
  },
  {
    to: '/login',
    title: 'Sign in',
    path: '/login',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M15 3 h4 a2 2 0 0 1 2 2 v14 a2 2 0 0 1 -2 2 h-4" />
        <polyline points="10 17 15 12 10 7" />
        <line x1="15" y1="12" x2="3" y2="12" />
      </svg>
    ),
  },
];

export function NotFoundPage() {
  useNoIndexMeta();
  const navigate = useNavigate();
  const deployEnabled = useMemo(() => readDeployEnabled(), []);
  const [query, setQuery] = useState('');

  // No /docs search component ships in this repo yet (DocsLandingPage does
  // not expose a search endpoint), so route to /apps with the query as a
  // filter hint. The apps directory already surfaces its own search, which
  // is the most useful destination for a typoed slug or renamed app.
  function handleSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    navigate(`/apps?q=${encodeURIComponent(q)}`);
  }

  return (
    <div className="page-root" style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <PageHead
        title="Page not found · Floom"
        description="This page doesn't exist on Floom. Head back to the homepage or try the app directory."
      />
      <TopBar />
      <main
        className="main"
        style={{
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden',
          flex: 1,
          paddingTop: 72,
          paddingBottom: 72,
        }}
      >
        <div
          className="not-found-inner"
          style={{
            position: 'relative',
            zIndex: 1,
            maxWidth: 780,
            margin: '0 auto',
            padding: '48px 24px 40px',
            boxSizing: 'border-box',
            width: '100%',
          }}
        >
          {/* Mono status badge — sets expectations before the display-font
              headline. Same visual language as the label-mono treatment
              used elsewhere in the marketing surfaces. */}
          <span
            data-testid="not-found-code-badge"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 12px',
              border: '1px solid var(--line)',
              borderRadius: 999,
              background: 'var(--card)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--muted)',
              marginBottom: 18,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--muted)',
              }}
            />
            404 · not found
          </span>

          {/* v17 parity 2026-04-24: "This page ran away." per wireframe
              spec. Display-font (Inter 800 tight-tracked) — wireframe.css
              decision log supersedes the stale DM Serif Display on
              wireframes.floom.dev. Green accent on "ran away." echoes the
              headline-dim treatment used elsewhere but flipped to accent,
              matching the wireframe's `.nf-h1 .accent` rule. */}
          <h1
            className="headline"
            data-testid="not-found-headline"
            style={{
              fontSize: 56,
              lineHeight: 1.02,
              letterSpacing: '-0.025em',
              margin: '0 0 14px',
            }}
          >
            This page <span style={{ color: 'var(--accent)' }}>ran away.</span>
          </h1>
          <p
            className="subhead"
            data-testid="not-found-subhead"
            style={{
              fontSize: 17,
              maxWidth: 520,
              margin: '0 auto 28px',
              lineHeight: 1.5,
            }}
          >
            Either it never existed, or the app was unpublished. Search the
            catalogue or jump to one of the popular destinations below.
          </p>

          {/* Search input. There's no docs/apps search SDK on the client
              today, so submission routes to /apps?q=... — the apps
              directory already ships its own filter box that reads ?q. */}
          <form
            onSubmit={handleSearch}
            data-testid="not-found-search"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              padding: '10px 14px',
              maxWidth: 480,
              margin: '0 auto 28px',
              transition: 'border-color 0.12s',
            }}
          >
            <svg
              aria-hidden="true"
              width={18}
              height={18}
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--muted)"
              strokeWidth={1.75}
              strokeLinecap="round"
              style={{ flexShrink: 0 }}
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search apps — try 'lead scorer' or 'jwt'"
              aria-label="Search Floom apps"
              data-testid="not-found-search-input"
              style={{
                flex: 1,
                border: 0,
                outline: 'none',
                background: 'transparent',
                fontSize: 15,
                fontFamily: 'inherit',
                color: 'var(--ink)',
                minWidth: 0,
                padding: 0,
              }}
            />
            <button
              type="submit"
              aria-label="Submit search"
              data-testid="not-found-search-submit"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.04em',
                color: 'var(--muted)',
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                padding: '4px 8px',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Enter
            </button>
          </form>

          <div
            className="not-found-ctas"
            data-testid="not-found-ctas"
            style={{
              display: 'flex',
              gap: 10,
              justifyContent: 'center',
              flexWrap: 'wrap',
              marginBottom: 48,
            }}
          >
            <Link
              to="/apps"
              data-testid="not-found-cta-apps"
              style={primaryCtaStyle}
            >
              Browse all apps
            </Link>
            <Link
              to="/"
              data-testid="not-found-cta-home"
              style={secondaryCtaStyle}
            >
              Back to home
            </Link>
          </div>

          <section
            className="not-found-popular"
            data-testid="not-found-popular"
            style={{
              textAlign: 'left',
              maxWidth: 720,
              margin: '0 auto',
              paddingTop: 40,
              borderTop: '1px solid var(--line)',
            }}
          >
            <p
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--muted)',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
                margin: '0 0 14px',
              }}
            >
              Popular right now
            </p>
            <div
              className="not-found-pop-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 10,
              }}
            >
              {POPULAR_LINKS.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  data-testid={`not-found-popular-${link.to.replace(/[/]/g, '-') || '-home'}`}
                  style={popCardStyle}
                  className="not-found-pop-card"
                >
                  <span style={popIconChipStyle} aria-hidden="true">
                    {link.icon}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={popTitleStyle}>{link.title}</span>
                    <span style={popPathStyle}>{link.path}</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>

          {/* Keep the waitlist nudge for non-deploy builds — it was the
              previous 404's main CTA pillar. Demoted to a quiet one-liner
              under the popular grid so it doesn't compete with Browse /
              Back to home. */}
          {!deployEnabled && (
            <p
              data-testid="not-found-waitlist-note"
              style={{
                marginTop: 28,
                fontSize: 13,
                color: 'var(--muted)',
              }}
            >
              Want to publish your own app?{' '}
              <Link
                to="/waitlist?source=404"
                style={{
                  color: 'var(--accent)',
                  fontWeight: 600,
                  textDecoration: 'underline',
                }}
              >
                Join the waitlist
              </Link>
              .
            </p>
          )}
        </div>
      </main>
      {/* Landing visual audit 2026-04-18: 404 previously had no footer,
          leaving a tall screen with just the glow mark echo and two
          pills. Reuse PublicFooter so 404 exposes the same trust links
          (Docs / GitHub / Privacy / Terms / Cookies) as the landing. */}
      <PublicFooter />
    </div>
  );
}

const primaryCtaStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '11px 20px',
  background: 'var(--accent)',
  color: '#fff',
  border: '1px solid var(--accent)',
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  textDecoration: 'none',
  boxShadow:
    '0 4px 14px rgba(5,150,105,0.22), inset 0 1px 0 rgba(255,255,255,0.18)',
};

const secondaryCtaStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '11px 20px',
  background: 'var(--card)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  textDecoration: 'none',
};

const popCardStyle: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 12,
  padding: '14px 16px',
  textDecoration: 'none',
  color: 'inherit',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  transition: 'border-color 0.12s, transform 0.12s, box-shadow 0.12s',
};

const popIconChipStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  color: 'var(--ink)',
};

const popTitleStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13.5,
  fontWeight: 600,
  lineHeight: 1.3,
  color: 'var(--ink)',
};

const popPathStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'var(--muted)',
  marginTop: 2,
  fontFamily: 'var(--font-mono)',
};
