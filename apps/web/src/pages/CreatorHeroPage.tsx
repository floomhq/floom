import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { TopBar } from '../components/TopBar';
import { PublicFooter } from '../components/public/PublicFooter';
import { AppStripe } from '../components/public/AppStripe';
import { FeedbackButton } from '../components/FeedbackButton';
import { IntegrationLogos } from '../components/home/IntegrationLogos';
import { ArchitectureDiagram } from '../components/home/ArchitectureDiagram';
import { InlineDemo } from '../components/home/InlineDemo';
import { WhyFloom } from '../components/home/WhyFloom';
import { LayersGrid } from '../components/home/LayersGrid';
import { McpSnippet } from '../components/home/McpSnippet';
import { BuiltBy } from '../components/home/BuiltBy';
import { getHub } from '../api/client';
import type { HubApp } from '../lib/types';
import { publicHubApps } from '../lib/hub-filter';
import { LAUNCH_APPS } from '../data/demoData';

interface Stripe {
  slug: string;
  name: string;
  description: string;
}

// Landing v2 (2026-04-18): widen the stripe roster from 3 to 5. These are
// real apps running on preview.floom.dev/api/hub. If any slug isn't live
// when the hub call resolves, we fall back gracefully to whatever IS live.
const PREFERRED_SLUGS = ['opendraft', 'openpaper', 'bouncer', 'openslides', 'uuid'] as const;

const FALLBACK_STRIPES: Stripe[] = [
  {
    slug: 'opendraft',
    name: 'opendraft',
    description: 'Draft posts, docs, and emails from a prompt',
  },
  {
    slug: 'openpaper',
    name: 'openpaper',
    description: 'Turn any PDF into a conversation',
  },
  {
    slug: 'bouncer',
    name: 'bouncer',
    description: 'Independent quality audits for your work',
  },
  {
    slug: 'openslides',
    name: 'openslides',
    description: 'Pitch decks from a single brief',
  },
  {
    slug: 'uuid',
    name: 'uuid',
    description: 'Zero-config UUID generator. No inputs, always works.',
  },
];

function pickStripes(apps: HubApp[]): Stripe[] {
  if (apps.length === 0) return FALLBACK_STRIPES;
  const bySlug = new Map(apps.map((app) => [app.slug, app]));
  const picked: Stripe[] = [];
  for (const slug of PREFERRED_SLUGS) {
    const hit = bySlug.get(slug);
    if (hit) picked.push({ slug: hit.slug, name: hit.name, description: hit.description });
  }
  if (picked.length >= 5) return picked.slice(0, 5);
  for (const app of apps) {
    if (picked.some((p) => p.slug === app.slug)) continue;
    picked.push({ slug: app.slug, name: app.name, description: app.description });
    if (picked.length >= 5) break;
  }
  return picked.length >= 3 ? picked : FALLBACK_STRIPES;
}

export function CreatorHeroPage() {
  const navigate = useNavigate();
  const [openapiUrl, setOpenapiUrl] = useState('');
  const [stripes, setStripes] = useState<Stripe[]>(FALLBACK_STRIPES);
  const [hubCount, setHubCount] = useState<number | null>(null);

  useEffect(() => {
    document.title =
      'Floom · Production infrastructure for AI apps that do real work';
    getHub()
      .then((apps) => {
        // Filter QA/test fixtures so the landing "N apps running right
        // now" matches the /apps directory header count. Single source
        // of truth: lib/hub-filter.ts.
        const visible = publicHubApps(apps);
        setHubCount(visible.length);
        if (visible.length > 0) setStripes(pickStripes(visible));
      })
      .catch(() => {
        // Keep the static roster on failure.
      });
  }, []);

  const enrichedFallbackStripes = useMemo(() => {
    return FALLBACK_STRIPES.map((s) => {
      const demo = LAUNCH_APPS.find((a) => a.slug === s.slug);
      return demo ? { slug: s.slug, name: demo.name, description: demo.tagline } : s;
    });
  }, []);

  const visibleStripes = stripes === FALLBACK_STRIPES ? enrichedFallbackStripes : stripes;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const url = openapiUrl.trim();
    if (!url) {
      navigate('/build');
      return;
    }
    navigate(`/build?openapi=${encodeURIComponent(url)}`);
  };

  return (
    <div
      className="page-root"
      data-testid="creator-hero"
      style={{ minHeight: '100vh', background: 'var(--bg)' }}
    >
      <TopBar />

      <main style={{ display: 'block' }}>
        {/* HERO (2026-04-19 UX pass):
            - Removed centered pennant: nav logo already carries the brand.
            - Single serif display layer (H1). Sub downgraded to Inter muted
              so hierarchy is H1 > accent > sub > input.
            - Dual CTA (Publish spec / Browse apps) so both ICPs land.
            - Radial glow softened from 0.08 to 0.05 opacity.
            - Section padding shortened so the form clears the fold at
              1279x712. */}
        <section
          data-testid="hero"
          style={{
            position: 'relative',
            padding: '72px 24px 64px',
            background:
              'radial-gradient(ellipse 720px 380px at 50% 30%, rgba(5,150,105,0.05), transparent 70%)',
          }}
        >
          <div
            style={{
              maxWidth: 880,
              margin: '0 auto',
              textAlign: 'center',
            }}
          >
            {/* H1 (locked 2026-04-18). Kept copy verbatim. Sized down to
                68px so it fits two lines at 1279px. */}
            <h1
              className="hero-headline"
              style={{
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontWeight: 400,
                fontSize: 68,
                lineHeight: 1.04,
                letterSpacing: '-0.025em',
                color: 'var(--ink)',
                margin: '0 0 16px',
                textWrap: 'balance' as unknown as 'balance',
              }}
            >
              Production infrastructure for AI apps that do real work.
            </h1>

            {/* Accent line, green value prop (locked). Promoted above
                the sub so the user sees the benefit before the
                positioning. */}
            <p
              className="hero-accent"
              data-testid="hero-accent"
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 17,
                lineHeight: 1.4,
                fontWeight: 600,
                letterSpacing: '-0.005em',
                color: 'var(--accent)',
                margin: '0 0 8px',
              }}
            >
              Vibe-coding speed. Production-grade safety.
            </p>

            {/* Sub-positioning (locked copy). Downgraded from serif 26px
                to Inter muted 16px: positioning line, not a headline. */}
            <p
              className="hero-sub-positioning"
              data-testid="hero-sub-positioning"
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 16,
                lineHeight: 1.5,
                fontWeight: 400,
                color: 'var(--muted)',
                margin: '0 0 32px',
              }}
            >
              The protocol + runtime for agentic work.
            </p>

            <form
              onSubmit={handleSubmit}
              className="hero-input"
              data-testid="hero-form"
              style={{
                background: 'var(--card)',
                border: '2px solid var(--ink)',
                borderRadius: 16,
                padding: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                boxShadow: '0 4px 0 var(--ink)',
                maxWidth: 620,
                margin: '0 auto',
              }}
            >
              <input
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                value={openapiUrl}
                onChange={(e) => setOpenapiUrl(e.target.value)}
                placeholder="github.com/you/repo  or  your-api.com/openapi.json"
                aria-label="OpenAPI spec URL"
                data-testid="hero-input"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 0,
                  outline: 'none',
                  padding: '16px 16px',
                  fontSize: 15,
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  background: 'transparent',
                  color: 'var(--ink)',
                }}
              />
              <button
                type="submit"
                data-testid="hero-cta"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'var(--accent)',
                  color: '#fff',
                  border: '1px solid var(--accent)',
                  borderRadius: 10,
                  padding: '14px 22px',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                Publish spec
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </form>

            {/* Secondary CTA: always-visible "Browse apps" so the biz
                ICP has a lane without having to parse the input. Linear
                / Vercel pattern: two CTAs side-by-side, one primary
                (green) one secondary (outline). */}
            <div
              className="hero-cta-row"
              style={{
                marginTop: 14,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
                fontSize: 14,
                color: 'var(--muted)',
                flexWrap: 'wrap',
              }}
            >
              <span>No API yet?</span>
              <Link
                to="/apps"
                data-testid="hero-browse-apps"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  color: 'var(--ink)',
                  fontWeight: 600,
                  textDecoration: 'none',
                  padding: '8px 14px',
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                  background: 'var(--card)',
                }}
              >
                Browse live apps
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>

            <IntegrationLogos />

            {/* Compact trust row (new 2026-04-19): the only quantified
                proof above the fold. Live hub count from /api/hub, plus
                two static truths ("6 layers", "5 surfaces") that match
                the rest of the page. No fabricated metrics. */}
            <div
              className="hero-stats"
              data-testid="hero-stats"
              style={{
                marginTop: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 36,
                color: 'var(--muted)',
                fontSize: 13,
                flexWrap: 'wrap',
              }}
            >
              <Stat
                value={hubCount !== null ? String(hubCount) : '—'}
                label="apps live"
              />
              <StatDivider />
              <Stat value="6" label="layers shipped" />
              <StatDivider />
              <Stat value="5" label="surfaces" />
              <StatDivider />
              <Stat value="OSS" label="Docker-first" />
            </div>
          </div>
        </section>

        {/* ARCHITECTURE · one spec, five surfaces */}
        <ArchitectureDiagram />

        {/* INLINE DEMO · real /api/run/uuid executed in-page */}
        <InlineDemo />

        {/* WHY · problem / solution / proof */}
        <WhyFloom />

        {/* LAYERS · what ships today */}
        <LayersGrid />

        {/* FEATURED APPS · polished 5-stripe list, live count from /api/hub
            2026-04-19 pass: compressed from a 40px serif header block
            to an inline header row that matches Linear / Vercel's live-
            feed patterns. The stripes do the talking. */}
        <section
          data-testid="try-now-section"
          data-section="featured-apps"
          style={{
            background: 'var(--bg)',
            padding: '72px 24px',
          }}
        >
          <div style={{ maxWidth: 760, margin: '0 auto' }}>
            <header
              className="live-apps-header"
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 16,
                marginBottom: 22,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <h2
                  style={{
                    fontFamily: "'Inter', system-ui, sans-serif",
                    fontWeight: 700,
                    fontSize: 22,
                    lineHeight: 1.2,
                    letterSpacing: '-0.015em',
                    color: 'var(--ink)',
                    margin: 0,
                  }}
                >
                  Live apps now
                </h2>
                {hubCount !== null && (
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--accent)',
                      background: '#ecfdf5',
                      border: '1px solid #d1fae5',
                      padding: '2px 8px',
                      borderRadius: 999,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {hubCount} running
                  </span>
                )}
              </div>
              <a
                href="/apps"
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  textDecoration: 'none',
                  fontWeight: 500,
                }}
              >
                See every live app →
              </a>
            </header>

            <div style={{ display: 'grid', gap: 12 }}>
              {visibleStripes.map((s) => (
                <AppStripe
                  key={s.slug}
                  slug={s.slug}
                  name={s.name}
                  description={s.description}
                  variant="landing"
                />
              ))}
            </div>
          </div>
        </section>

        {/* MCP SNIPPET · Claude Desktop integration in 3 lines */}
        <McpSnippet />

        {/* SELF-HOST · one docker line + boot output */}
        <section
          id="self-host"
          data-testid="self-host-section"
          data-section="self-host"
          style={{
            background: 'var(--card)',
            borderTop: '1px solid var(--line)',
            padding: '72px 24px',
          }}
        >
          <div style={{ maxWidth: 620, margin: '0 auto', textAlign: 'center' }}>
            <h2
              style={{
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontWeight: 400,
                fontSize: 40,
                lineHeight: 1.15,
                letterSpacing: '-0.02em',
                color: 'var(--ink)',
                margin: '0 0 14px',
              }}
            >
              Run it on your own box.
            </h2>
            <p
              style={{
                fontSize: 15,
                color: 'var(--muted)',
                margin: '0 0 28px',
                lineHeight: 1.55,
              }}
            >
              One command. Every Floom layer is open source and runs in
              one container.
            </p>
            <div
              style={{
                background: '#0b1220',
                color: '#e2e8f0',
                borderRadius: 12,
                padding: '20px 22px',
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 13.5,
                lineHeight: 1.85,
                textAlign: 'left',
                maxWidth: 560,
                margin: '0 auto',
                overflowX: 'auto',
              }}
            >
              <div>
                <span style={{ color: '#8b9ba9' }}>$</span>{' '}
                <span style={{ color: '#6ee7b7' }}>docker run -p 3010:3010 floomhq/floom</span>
              </div>
              <div style={{ color: '#94a3b8', marginTop: 6 }}>
                <span style={{ color: '#6ee7b7' }}>✓</span> Started · 14 apps registered · MCP listening on :3051
              </div>
            </div>
            <p style={{ marginTop: 24, fontSize: 14 }}>
              <a
                href="https://github.com/floomhq/floom#self-host"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--muted)', textDecoration: 'underline' }}
              >
                Need to customize? Read the self-host guide →
              </a>
            </p>
          </div>
        </section>

        {/* BUILT BY · small credit + github star count */}
        <BuiltBy />
      </main>

      <PublicFooter />
      <FeedbackButton />

      {/* Inline responsive tweaks (2026-04-19): typography shrinks so
         the single-serif headline fits two lines at every viewport. */}
      <style>{`
        @media (max-width: 900px) {
          .hero-headline { font-size: 52px !important; }
          .hero-accent { font-size: 16px !important; }
          .hero-stats { gap: 24px !important; }
        }
        @media (max-width: 640px) {
          [data-testid="hero"] { padding: 48px 20px 48px; }
          .hero-headline { font-size: 36px !important; line-height: 1.07 !important; margin-bottom: 14px !important; }
          .hero-accent { font-size: 14px !important; margin-bottom: 6px !important; }
          .hero-sub-positioning { font-size: 15px !important; margin-bottom: 22px !important; }
          .hero-input { flex-direction: column !important; align-items: stretch !important; padding: 10px !important; }
          .hero-input input { padding: 14px !important; font-size: 13.5px !important; }
          .hero-input button { width: 100% !important; padding: 14px !important; justify-content: center !important; }
          .hero-cta-row { gap: 10px !important; }
          .hero-stats { gap: 18px !important; font-size: 12px !important; }
          .integration-logos { flex-direction: column !important; gap: 12px !important; }
          .live-apps-header { flex-direction: column !important; align-items: flex-start !important; }
        }
      `}</style>
    </div>
  );
}

/** Single quantified stat for the compact trust row under the hero. */
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 15,
          fontWeight: 700,
          color: 'var(--ink)',
          letterSpacing: '-0.01em',
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span>
    </span>
  );
}

function StatDivider() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 1,
        height: 14,
        background: 'var(--line)',
      }}
    />
  );
}
