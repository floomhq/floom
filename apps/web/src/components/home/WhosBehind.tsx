/**
 * WhosBehind — small "who's building this" band near the bottom of the
 * landing page.
 *
 * Federico 2026-04-23 (#589): people landing on floom.dev from cold
 * channels want to see a face before they sign up. One photo, one
 * paragraph of context, three direct-contact links. No elaborate team
 * grid, no "our story" copy — this is a single-founder project, the
 * band should say that.
 *
 * Photo file is served from /team/fede.jpg in the public folder. The
 * repo ships a 1x1 PLACEHOLDER file so the layout doesn't collapse;
 * Federico swaps the file locally when he has a photo he likes. See
 * apps/web/public/team/README for the swap instructions.
 *
 * License note: core runtime is MIT. We keep that fact at the repo
 * root (LICENSE) and in /docs, and don't repeat it as a standalone
 * footer line per MEMORY.md "never write 'open source · MIT licensed'"
 * rule — this band already points to the GitHub repo where the license
 * lives.
 */
import type { CSSProperties } from 'react';

import { SectionEyebrow } from './SectionEyebrow';

const SECTION_STYLE: CSSProperties = {
  padding: '56px 28px 64px',
  maxWidth: 900,
  margin: '0 auto',
};

const GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '160px 1fr',
  gap: 32,
  alignItems: 'center',
  maxWidth: 720,
  margin: '0 auto',
};

const PHOTO_WRAP_STYLE: CSSProperties = {
  width: 160,
  height: 160,
  borderRadius: 999,
  overflow: 'hidden',
  background: 'var(--studio, #f6f5f1)',
  border: '1px solid var(--line)',
  position: 'relative',
};

const PHOTO_IMG_STYLE: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};

const H2_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 26,
  lineHeight: 1.15,
  letterSpacing: '-0.02em',
  margin: '6px 0 10px',
  color: 'var(--ink)',
};

const BODY_STYLE: CSSProperties = {
  fontSize: 15,
  color: 'var(--muted)',
  lineHeight: 1.6,
  margin: '0 0 16px',
};

const LINKS_ROW_STYLE: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const LINK_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 12px',
  borderRadius: 999,
  background: 'var(--card)',
  border: '1px solid var(--line)',
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--ink)',
  textDecoration: 'none',
  fontFamily: "'Inter', system-ui, sans-serif",
};

export function WhosBehind() {
  return (
    <section data-testid="whos-behind" style={SECTION_STYLE}>
      <div className="whos-behind-grid" style={GRID_STYLE}>
        {/* Photo: /team/fede.webp (225KB, q=85) is the primary source;
            /team/fede.jpg (757KB) stays in the repo as a fallback for
            browsers without webp support. <picture> lets the browser
            pick the smaller file. 2026-04-24 size optimization. */}
        <div style={PHOTO_WRAP_STYLE}>
          <picture>
            <source srcSet="/team/fede.webp" type="image/webp" />
            <img
              src="/team/fede.jpg"
              alt="Federico De Ponte"
              width={160}
              height={160}
              style={PHOTO_IMG_STYLE}
              loading="lazy"
            />
          </picture>
        </div>

        <div>
          <SectionEyebrow>Who&rsquo;s behind it</SectionEyebrow>
          <h2 style={H2_STYLE}>Federico De Ponte.</h2>
          <p style={BODY_STYLE}>
            Ex-founder of SCAILE (reached $600K ARR, team of 10, left in
            March 2026). Building Floom full-time from San Francisco. If
            you&rsquo;re shipping an agent-era app and something on the
            page is unclear, please write &mdash; the fastest way to reach
            me is email.
          </p>
          <p style={{ ...BODY_STYLE, marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>
            Backed by <a href="https://f.inc" target="_blank" rel="noreferrer" style={{ color: 'var(--ink)', fontWeight: 600, textDecoration: 'none', borderBottom: '1px solid var(--line)' }}>Founders Inc</a>.
          </p>
          <div style={LINKS_ROW_STYLE}>
            <a
              href="https://www.linkedin.com/in/federicodeponte"
              target="_blank"
              rel="noreferrer"
              data-testid="whos-behind-linkedin"
              style={LINK_STYLE}
            >
              <LinkedInMark />
              LinkedIn
            </a>
            <a
              href="https://github.com/federicodeponte"
              target="_blank"
              rel="noreferrer"
              data-testid="whos-behind-github"
              style={LINK_STYLE}
            >
              <GitHubMark />
              GitHub
            </a>
            <a
              href="mailto:fede@floom.dev"
              data-testid="whos-behind-email"
              style={LINK_STYLE}
            >
              <MailMark />
              fede@floom.dev
            </a>
          </div>
        </div>
      </div>

      {/* Inline marks kept local so WhosBehind doesn't depend on
          lucide-react's icon set (the project pins 1.8.0 which is
          missing Github/Linkedin). All three icons share size+stroke
          so the chip row stays visually level. */}

      <style>{`
        @media (max-width: 640px) {
          .whos-behind-grid {
            grid-template-columns: 1fr !important;
            justify-items: center !important;
            text-align: center !important;
            gap: 20px !important;
          }
          .whos-behind-grid > div:last-child {
            text-align: center !important;
          }
          .whos-behind-grid > div:last-child > div[role="list"],
          .whos-behind-grid > div:last-child > div:last-child {
            justify-content: center !important;
          }
        }
      `}</style>
    </section>
  );
}

function LinkedInMark() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <path d="M20.452 20.452h-3.555v-5.569c0-1.328-.026-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.353V9h3.414v1.561h.048c.476-.9 1.637-1.852 3.37-1.852 3.602 0 4.268 2.37 4.268 5.455v6.288zM5.337 7.433a2.062 2.062 0 01-2.062-2.063 2.062 2.062 0 114.125 0c0 1.139-.924 2.063-2.063 2.063zM7.114 20.452H3.558V9h3.556v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function MailMark() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}
