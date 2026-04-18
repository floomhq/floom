import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Logo } from '../components/Logo';
import { PublicNav } from '../components/public/PublicNav';
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
      <PublicNav variant="landing" />

      <main style={{ display: 'block' }}>
        {/* HERO · glow logo, 3-layer headline, paste-URL input, integration logos */}
        <section
          data-testid="hero"
          style={{
            position: 'relative',
            padding: '120px 24px 96px',
            background:
              'radial-gradient(ellipse 900px 500px at 50% 30%, rgba(5,150,105,0.08), transparent 70%)',
          }}
        >
          <div
            style={{
              maxWidth: 920,
              margin: '0 auto',
              textAlign: 'center',
            }}
          >
            <div
              aria-hidden="true"
              style={{
                margin: '0 auto 28px',
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <Logo variant="glow" size={112} animate="breathe" />
            </div>

            {/* H1 (locked 2026-04-18): benefit-forward, replaces the
                prior "protocol + runtime" line which now lives as a
                secondary sub below. */}
            <h1
              className="hero-headline"
              style={{
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontWeight: 400,
                fontSize: 76,
                lineHeight: 1.03,
                letterSpacing: '-0.025em',
                color: 'var(--ink)',
                margin: '0 0 16px',
                textWrap: 'balance' as unknown as 'balance',
              }}
            >
              Production infrastructure for AI apps that do real work.
            </h1>

            {/* Sub-positioning (locked 2026-04-18). */}
            <p
              className="hero-sub-positioning"
              data-testid="hero-sub-positioning"
              style={{
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontSize: 26,
                lineHeight: 1.3,
                fontWeight: 400,
                letterSpacing: '-0.01em',
                color: 'var(--ink)',
                margin: '0 0 12px',
              }}
            >
              The protocol + runtime for agentic work.
            </p>

            {/* Accent line, green value prop. */}
            <p
              className="hero-accent"
              data-testid="hero-accent"
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 18,
                lineHeight: 1.4,
                fontWeight: 600,
                letterSpacing: '-0.005em',
                color: 'var(--accent)',
                margin: '0 0 40px',
              }}
            >
              Vibe-coding speed. Production-grade safety.
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
                  padding: '18px 18px',
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
                  padding: '16px 24px',
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                Try it
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </form>

            <p
              style={{
                marginTop: 18,
                fontSize: 14,
                color: 'var(--muted)',
                textAlign: 'center',
              }}
            >
              No API yet?{' '}
              <a
                href="/apps"
                data-testid="hero-browse-apps"
                style={{ color: 'var(--ink)', fontWeight: 500, textDecoration: 'underline' }}
              >
                Browse live apps
              </a>
              .
            </p>

            <IntegrationLogos />
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

        {/* FEATURED APPS · polished 5-stripe list, live count from /api/hub */}
        <section
          data-testid="try-now-section"
          data-section="featured-apps"
          style={{
            background: 'var(--bg)',
            padding: '96px 24px',
          }}
        >
          <div style={{ maxWidth: 760, margin: '0 auto' }}>
            <header style={{ textAlign: 'center', marginBottom: 36 }}>
              <h2
                style={{
                  fontFamily: "'DM Serif Display', Georgia, serif",
                  fontWeight: 400,
                  fontSize: 40,
                  lineHeight: 1.1,
                  letterSpacing: '-0.02em',
                  color: 'var(--ink)',
                  margin: '0 0 12px',
                }}
              >
                Live apps.
              </h2>
              <p
                style={{
                  fontSize: 16,
                  color: 'var(--muted)',
                  lineHeight: 1.55,
                  margin: 0,
                }}
              >
                {hubCount !== null
                  ? `${hubCount} apps running right now. Tap one to try it.`
                  : 'Apps running right now. Tap one to try it.'}
              </p>
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
            <p style={{ marginTop: 24, textAlign: 'center', fontSize: 14 }}>
              <a
                href="/apps"
                style={{ color: 'var(--muted)', textDecoration: 'underline' }}
              >
                See every live app →
              </a>
            </p>
          </div>
        </section>

        {/* MCP SNIPPET · Claude Desktop integration in 3 lines */}
        <McpSnippet />

        {/* SELF-HOST · one docker line + boot output */}
        <section
          data-testid="self-host-section"
          data-section="self-host"
          style={{
            background: 'var(--card)',
            borderTop: '1px solid var(--line)',
            padding: '96px 24px',
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
                fontSize: 16,
                color: 'var(--muted)',
                margin: '0 0 32px',
                lineHeight: 1.6,
              }}
            >
              One command. Everything Floom runs on, open source, self-hostable.
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
                <span style={{ color: '#64748b' }}>$</span>{' '}
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

      {/* Inline responsive tweaks — mobile column stacks everything and
         shrinks the typography so the three-layer headline stays legible
         at 375px without horizontal overflow. */}
      <style>{`
        @media (max-width: 900px) {
          .hero-headline { font-size: 56px !important; }
          .hero-sub-positioning { font-size: 22px !important; }
          .hero-accent { font-size: 16px !important; margin-bottom: 28px !important; }
        }
        @media (max-width: 640px) {
          [data-testid="hero"] { padding: 64px 20px 56px; }
          .hero-headline { font-size: 40px !important; line-height: 1.07 !important; margin-bottom: 12px !important; }
          .hero-sub-positioning { font-size: 18px !important; margin-bottom: 10px !important; }
          .hero-accent { font-size: 14px !important; margin-bottom: 24px !important; }
          .hero-input { flex-direction: column !important; align-items: stretch !important; padding: 10px !important; }
          .hero-input input { padding: 14px !important; font-size: 13.5px !important; }
          .hero-input button { width: 100% !important; padding: 14px !important; justify-content: center !important; }
          .integration-logos { flex-direction: column !important; gap: 12px !important; }
        }
      `}</style>
    </div>
  );
}
