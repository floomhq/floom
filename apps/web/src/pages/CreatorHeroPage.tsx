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
import { HeroAppTiles } from '../components/home/HeroAppTiles';
import { ProofRow } from '../components/home/ProofRow';
import { SectionEyebrow } from '../components/home/SectionEyebrow';
import * as api from '../api/client';
import { useSession } from '../hooks/useSession';
import type { DetectedApp, HubApp } from '../lib/types';
import { publicHubApps } from '../lib/hub-filter';
import { LAUNCH_APPS } from '../data/demoData';

interface Stripe {
  slug: string;
  name: string;
  description: string;
}

// Landing v4 (2026-04-20): keep the 5-slug preference. Tiles + stripes
// share the same roster so the hero teaser and the featured section
// stay in sync.
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

const PENDING_KEY = 'floom:pending-publish';

type PendingPublish = {
  detected: DetectedApp;
  name: string;
  slug: string;
  description: string;
  category: string;
  visibility: 'public' | 'private' | 'auth-required';
  source: 'github' | 'openapi';
};

function normalizeLink(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function githubCandidates(raw: string): string[] {
  const normalized = normalizeLink(raw);
  const m = normalized.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i);
  if (!m) return [];
  const [, owner, repo] = m;
  const bases = [
    `https://raw.githubusercontent.com/${owner}/${repo}/main`,
    `https://raw.githubusercontent.com/${owner}/${repo}/master`,
  ];
  const paths = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'docs/openapi.yaml', 'api/openapi.yaml'];
  const urls: string[] = [];
  for (const base of bases) {
    for (const path of paths) urls.push(`${base}/${path}`);
  }
  return urls;
}

function persistPendingPublish(detected: DetectedApp, source: 'github' | 'openapi') {
  const pending: PendingPublish = {
    detected,
    name: detected.name,
    slug: detected.slug,
    description: detected.description,
    category: detected.category || '',
    visibility: 'public',
    source,
  };
  window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

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
  const { isAuthenticated } = useSession();
  const [sourceLink, setSourceLink] = useState('');
  const [heroError, setHeroError] = useState('');
  const [isDetecting, setIsDetecting] = useState(false);
  const [stripes, setStripes] = useState<Stripe[]>(FALLBACK_STRIPES);
  const [hubCount, setHubCount] = useState<number | null>(null);

  useEffect(() => {
    document.title =
      'Floom · Production infrastructure for AI apps that do real work';
    api
      .getHub()
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setHeroError('');

    const rawLink = sourceLink.trim();
    if (!rawLink) {
      navigate(
        isAuthenticated
          ? '/studio/build'
          : '/signup?next=' + encodeURIComponent('/studio/build'),
      );
      return;
    }

    setIsDetecting(true);
    try {
      window.localStorage.removeItem(PENDING_KEY);
    } catch {
      // Ignore storage failures; the redirect still works for signed-in users.
    }

    try {
      const candidates = githubCandidates(rawLink);
      if (candidates.length > 0) {
        for (const candidate of candidates) {
          try {
            const detected = await api.detectApp(candidate);
            persistPendingPublish(detected, 'github');
            navigate(
              isAuthenticated
                ? '/studio/build'
                : '/signup?next=' + encodeURIComponent('/studio/build'),
            );
            return;
          } catch {
            // Try the next candidate path.
          }
        }
        setHeroError(
          "We couldn't find an openapi.yaml or openapi.json file in that repo yet. Add one, or paste the direct OpenAPI link instead.",
        );
        return;
      }

      const detected = await api.detectApp(normalizeLink(rawLink));
      persistPendingPublish(detected, 'openapi');
      navigate(
        isAuthenticated
          ? '/studio/build'
          : '/signup?next=' + encodeURIComponent('/studio/build'),
      );
    } catch (err) {
      const message =
        err instanceof api.ApiError && err.status >= 400 && err.status < 500
          ? "Paste a public GitHub repo, or the direct link to an openapi.json or openapi.yaml file."
          : 'We could not read that link right now. Try again in a moment.';
      setHeroError(message);
    } finally {
      setIsDetecting(false);
    }
  };

  return (
    <div
      className="page-root"
      data-testid="creator-hero"
      style={{ minHeight: '100vh', background: 'var(--bg)' }}
    >
      <TopBar />

      <main style={{ display: 'block' }}>
        {/* HERO v4 (2026-04-20 deep audit):
            - Integration logos moved ABOVE H1 as a tight "WORKS WITH" strip.
              Gives the hero a visual anchor instead of opening with a
              typography wall.
            - H1 + accent + sub (all locked copy) retained but tightened:
              H1 60px on desktop, 52px on small desktop, 34px on mobile.
            - Dual equal-weight CTAs: Publish your app (primary emerald) +
              Browse 22 live apps (secondary outlined, same padding/height).
              v11 pattern restored.
            - 5-tile app strip directly under the CTAs. This is the single
              biggest structural fix: above-fold proof-of-life in the hero.
            - hero-stats chip removed from hero; promoted to a dedicated
              ProofRow section directly below. */}
        <section
          data-testid="hero"
          style={{
            position: 'relative',
            padding: '48px 24px 56px',
            background:
              'radial-gradient(ellipse 720px 360px at 50% 20%, rgba(5,150,105,0.05), transparent 70%)',
          }}
        >
          <div
            style={{
              maxWidth: 920,
              margin: '0 auto',
              textAlign: 'center',
            }}
          >
            {/* WORKS WITH logos strip — visual anchor above the typography.
                v11/v16 pattern. Same logos as before, smaller mono label. */}
            <div
              className="hero-works-with"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
                marginBottom: 20,
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                }}
              >
                Works with
              </span>
              <IntegrationLogos variant="inline" />
            </div>

            {/* H1 (locked 2026-04-18). 60px desktop so there's more room for
                the CTA + tile strip above the fold. */}
            <h1
              className="hero-headline"
              style={{
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontWeight: 400,
                fontSize: 60,
                lineHeight: 1.05,
                letterSpacing: '-0.025em',
                color: 'var(--ink)',
                margin: '0 0 14px',
                textWrap: 'balance' as unknown as 'balance',
              }}
            >
              Production infrastructure for AI apps that do real work.
            </h1>

            {/* Accent line (locked). */}
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
                margin: '0 0 6px',
              }}
            >
              Vibe-coding speed. Production-grade safety.
            </p>

            {/* Sub-positioning (locked copy). */}
            <p
              className="hero-sub-positioning"
              data-testid="hero-sub-positioning"
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 15,
                lineHeight: 1.5,
                fontWeight: 400,
                color: 'var(--muted)',
                margin: '0 0 26px',
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
                type="text"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                value={sourceLink}
                onChange={(e) => setSourceLink(e.target.value)}
                placeholder="github.com/you/api"
                aria-label="Public GitHub repo with OpenAPI, or direct OpenAPI link"
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
                disabled={isDetecting}
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
                  cursor: isDetecting ? 'wait' : 'pointer',
                  opacity: isDetecting ? 0.84 : 1,
                  whiteSpace: 'nowrap',
                }}
              >
                {isDetecting ? 'Checking link...' : 'Start setup'}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </form>

            {heroError && (
              <p
                data-testid="hero-error"
                style={{
                  maxWidth: 620,
                  margin: '12px auto 0',
                  padding: '12px 14px',
                  borderRadius: 12,
                  border: '1px solid #f3d7bf',
                  background: '#fff7ef',
                  color: '#7a4b19',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {heroError}
              </p>
            )}

            <div
              className="hero-cta-row"
              style={{
                marginTop: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <Link
                to="/apps"
                data-testid="hero-browse-apps"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  color: 'var(--ink)',
                  fontWeight: 600,
                  textDecoration: 'none',
                  padding: '12px 18px',
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                  background: 'var(--card)',
                  fontSize: 14,
                }}
              >
                Browse{hubCount !== null ? ` ${hubCount}` : ''} live apps
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
              <Link
                to="/docs/self-host"
                data-testid="hero-self-host"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  color: 'var(--muted)',
                  fontWeight: 500,
                  textDecoration: 'underline',
                  textUnderlineOffset: 3,
                  padding: '12px 8px',
                  fontSize: 13.5,
                }}
              >
                Self-host in one command
              </Link>
            </div>

            {/* Hero app-tile strip (new 2026-04-20). Proof-of-life above
                the fold: 5 compact chips showing real live apps, each
                linking to /p/:slug. */}
            <HeroAppTiles tiles={visibleStripes} />
          </div>
        </section>

        {/* PROOF ROW (new 2026-04-20): quantified trust strip. Extracted
            from the hero-stats inline chip into its own breathing-room
            section. */}
        <ProofRow hubCount={hubCount} />

        {/* INLINE DEMO (promoted): the strongest section on the page, now
            the first proof a scrolling user hits after the ProofRow. */}
        <InlineDemo />

        {/* FEATURED APPS (promoted from below-demo). The stripes do the
            heavy lifting; we lead into them with a compact inline header
            and an eyebrow. */}
        <section
          data-testid="try-now-section"
          data-section="featured-apps"
          style={{
            background: 'var(--bg)',
            padding: '72px 24px',
          }}
        >
          <div style={{ maxWidth: 820, margin: '0 auto' }}>
            <header
              className="live-apps-header"
              style={{
                marginBottom: 24,
              }}
            >
              <SectionEyebrow tone="accent" testid="live-apps-eyebrow">
                Live now · open these in a browser
              </SectionEyebrow>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 16,
                  flexWrap: 'wrap',
                }}
              >
                <h2
                  style={{
                    fontFamily: "'DM Serif Display', Georgia, serif",
                    fontWeight: 400,
                    fontSize: 34,
                    lineHeight: 1.1,
                    letterSpacing: '-0.02em',
                    color: 'var(--ink)',
                    margin: 0,
                  }}
                >
                  Real apps, running right now.
                </h2>
                <a
                  href="/apps"
                  style={{
                    fontSize: 13.5,
                    color: 'var(--muted)',
                    textDecoration: 'none',
                    fontWeight: 500,
                  }}
                >
                  See every live app →
                </a>
              </div>
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

        {/* WHY · problem / solution / proof (now with eyebrows) */}
        <WhyFloom />

        {/* LAYERS · what ships today (now with icon-badges) */}
        <LayersGrid />

        {/* ARCHITECTURE · demoted from pre-demo position. Retitled to
            "How a Floom app works" at the section level; dev-targeted
            section, now labeled as such with a FOR BUILDERS eyebrow. */}
        <ArchitectureDiagram />

        {/* MCP SNIPPET · Claude Desktop integration in 3 lines */}
        <McpSnippet />

        {/* SELF-HOST · one docker line + boot output. Simplified caption
            so the ":3051 MCP listening" jargon becomes plain English. */}
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
            <SectionEyebrow testid="self-host-eyebrow">
              For the open-source-first
            </SectionEyebrow>
            <h2
              style={{
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontWeight: 400,
                fontSize: 36,
                lineHeight: 1.1,
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
              One line in your terminal. Floom is open source, top to
              bottom. Your data stays with you.
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
                <span style={{ color: '#6ee7b7' }}>✓</span> Floom is up. 14 apps ready. Claude integration live.
              </div>
            </div>
            <p style={{ marginTop: 24, fontSize: 14 }}>
              <a
                href="https://github.com/floomhq/floom#self-host"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--muted)', textDecoration: 'underline' }}
              >
                Want the details? Read the self-host guide →
              </a>
            </p>
          </div>
        </section>

        {/* BUILT BY · small credit + github star count */}
        <BuiltBy />
      </main>

      <PublicFooter />
      <FeedbackButton />

      {/* Inline responsive tweaks v4: hero typography shrinks in steps so
         the full hero (logos + H1 + CTA + app tiles) fits on the first
         fold at every viewport. */}
      <style>{`
        @media (max-width: 1040px) {
          .hero-headline { font-size: 52px !important; }
        }
        @media (max-width: 780px) {
          .hero-headline { font-size: 42px !important; }
          .hero-works-with { gap: 10px !important; }
        }
        @media (max-width: 640px) {
          [data-testid="hero"] { padding: 36px 20px 40px !important; }
          .hero-headline { font-size: 34px !important; line-height: 1.08 !important; margin-bottom: 12px !important; }
          .hero-accent { font-size: 14px !important; margin-bottom: 4px !important; }
          .hero-sub-positioning { font-size: 14px !important; margin-bottom: 20px !important; }
          .hero-input { flex-direction: column !important; align-items: stretch !important; padding: 10px !important; }
          .hero-input input { padding: 14px !important; font-size: 13.5px !important; }
          .hero-input button { width: 100% !important; padding: 14px !important; justify-content: center !important; }
          .hero-cta-row { flex-direction: column !important; gap: 10px !important; }
          .hero-works-with { margin-bottom: 16px !important; }
          .integration-logos { flex-direction: column !important; gap: 10px !important; }
          .live-apps-header { flex-direction: column !important; align-items: flex-start !important; }
        }
      `}</style>
    </div>
  );
}
