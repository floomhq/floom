import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Logo } from '../components/Logo';
import { PublicNav } from '../components/public/PublicNav';
import { PublicFooter } from '../components/public/PublicFooter';
import { AppStripe } from '../components/public/AppStripe';
import { FeedbackButton } from '../components/FeedbackButton';
import { getHub } from '../api/client';
import type { HubApp } from '../lib/types';
import { LAUNCH_APPS } from '../data/demoData';

interface Stripe {
  slug: string;
  name: string;
  description: string;
}

// 2026-04-17 cut-before-launch: dropped `flyfast` (internal-only, AX41-infra
// gated) and swapped in `opendraft` so the homepage stripe doesn't tease an
// app nobody external can actually run.
const PREFERRED_SLUGS = ['opendraft', 'openpaper', 'bouncer'] as const;

// If the hub call fails or returns too few public apps, fall back to
// this curated trio so the homepage still looks right on a cold backend.
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
];

function pickStripes(apps: HubApp[]): Stripe[] {
  if (apps.length === 0) return FALLBACK_STRIPES;
  const bySlug = new Map(apps.map((app) => [app.slug, app]));
  const picked: Stripe[] = [];
  for (const slug of PREFERRED_SLUGS) {
    const hit = bySlug.get(slug);
    if (hit) picked.push({ slug: hit.slug, name: hit.name, description: hit.description });
  }
  if (picked.length >= 3) return picked.slice(0, 3);
  for (const app of apps) {
    if (picked.some((p) => p.slug === app.slug)) continue;
    picked.push({ slug: app.slug, name: app.name, description: app.description });
    if (picked.length >= 3) break;
  }
  return picked.length >= 3 ? picked : FALLBACK_STRIPES;
}

export function CreatorHeroPage() {
  const navigate = useNavigate();
  const [openapiUrl, setOpenapiUrl] = useState('');
  const [stripes, setStripes] = useState<Stripe[]>(FALLBACK_STRIPES);

  useEffect(() => {
    document.title = 'Floom · The protocol + runtime for agentic work';
    getHub()
      .then((apps) => {
        if (apps.length > 0) setStripes(pickStripes(apps));
      })
      .catch(() => {
        // Keep the static trio on failure.
      });
  }, []);

  // Fallback trio is used for the unit of SSR/no-JS. We also read the
  // LAUNCH_APPS table to enrich the fallback names with nicer casing if
  // the demo data is already loaded in-bundle.
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
        {/* HERO · radial green glow backdrop, big logo, one input, one CTA */}
        <section
          data-testid="hero"
          style={{
            position: 'relative',
            padding: '120px 24px 120px',
            background:
              'radial-gradient(ellipse 900px 500px at 50% 30%, rgba(5,150,105,0.08), transparent 70%)',
          }}
        >
          <div
            style={{
              maxWidth: 860,
              margin: '0 auto',
              textAlign: 'center',
            }}
          >
            <div
              aria-hidden="true"
              style={{
                margin: '0 auto 32px',
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <Logo variant="glow" size={140} animate="breathe" />
            </div>

            <h1
              className="hero-headline"
              style={{
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontWeight: 400,
                fontSize: 88,
                lineHeight: 1.02,
                letterSpacing: '-0.02em',
                color: 'var(--ink)',
                margin: '0 0 20px',
                textWrap: 'balance' as unknown as 'balance',
              }}
            >
              The protocol + runtime for agentic work.
            </h1>

            {/* Sub-tagline (locked 2026-04-18): displays immediately under the
                primary headline, carries the pitch line. Rendered as its own
                element so crawlers, OG tools, and wireframe audits can pick it
                up deterministically. */}
            <p
              className="hero-subtagline"
              data-testid="hero-subtagline"
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 22,
                lineHeight: 1.35,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                color: 'var(--accent)',
                margin: '0 0 24px',
              }}
            >
              Vibe-coding speed. Production-grade safety.
            </p>

            <p
              className="hero-subhead"
              style={{
                fontSize: 20,
                lineHeight: 1.5,
                color: 'var(--muted)',
                maxWidth: 640,
                margin: '0 auto 56px',
              }}
            >
              Build agents, workflows, and scripts with AI. Floom deploys them as an MCP server,
              HTTP API, and shareable web form.
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

            {/* Secondary path for consumers who don't have an OpenAPI spec:
                let them browse live apps right from the hero. Keeps the one-
                input-one-CTA v15 feel while giving a real answer to the
                question "what if I'm not a developer?". See 2026-04-18 audit
                finding #3. */}
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
          </div>
        </section>

        {/* BELOW FOLD 1 · three app stripes */}
        <section
          data-testid="try-now-section"
          style={{
            background: 'var(--card)',
            borderTop: '1px solid var(--line)',
            padding: '80px 24px',
          }}
        >
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <div style={{ textAlign: 'center', marginBottom: 40 }}>
              <span
                style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 11,
                  color: 'var(--muted)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  fontWeight: 500,
                }}
              >
                TRY ONE RUNNING RIGHT NOW
              </span>
            </div>

            <div style={{ display: 'grid', gap: 16 }}>
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

        {/* BELOW FOLD 2 · self-host */}
        <section
          data-testid="self-host-section"
          style={{
            background: 'var(--bg)',
            borderTop: '1px solid var(--line)',
            padding: '80px 24px',
          }}
        >
          <div style={{ maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
            <h2
              style={{
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontWeight: 400,
                fontSize: 36,
                lineHeight: 1.15,
                letterSpacing: '-0.02em',
                color: 'var(--ink)',
                margin: '0 0 16px',
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
              One command. Everything Floom runs on, open source.
            </p>
            <div
              style={{
                background: '#0b1220',
                color: '#6ee7b7',
                borderRadius: 12,
                padding: '20px 22px',
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 13.5,
                textAlign: 'left',
                maxWidth: 520,
                margin: '0 auto',
                overflowX: 'auto',
              }}
            >
              <span style={{ color: '#64748b' }}>$</span>{' '}
              <span>docker run -p 3010:3010 floomhq/floom</span>
            </div>
          </div>
        </section>
      </main>

      <PublicFooter />
      <FeedbackButton />

      {/* Inline responsive tweaks: match the mobile column in the
         v15 wireframe (shrink H1 to 44px, stack input + CTA). */}
      <style>{`
        @media (max-width: 640px) {
          [data-testid="hero"] { padding: 64px 20px 56px; }
          .hero-headline { font-size: 44px !important; line-height: 1.05 !important; margin-bottom: 14px !important; }
          .hero-subtagline { font-size: 16px !important; margin-bottom: 18px !important; }
          .hero-subhead { font-size: 16px !important; margin-bottom: 36px !important; }
          .hero-input { flex-direction: column !important; align-items: stretch !important; padding: 10px !important; }
          .hero-input input { padding: 14px !important; font-size: 13.5px !important; }
          .hero-input button { width: 100% !important; padding: 14px !important; justify-content: center !important; }
        }
      `}</style>
    </div>
  );
}
