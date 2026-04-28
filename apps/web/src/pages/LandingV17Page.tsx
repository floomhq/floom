/**
 * LandingV17Page — marketing home `/` rebuilt to the v17 wireframes.
 *
 * Sources of truth:
 *   /var/www/wireframes-floom/v17/landing.html            (desktop)
 *   /var/www/wireframes-floom/v17/landing-mobile.html     (mobile)
 *   /var/www/wireframes-floom/v17/REVISION-2026-04-22.md  (latest revisions)
 *   /root/floom-internal/launch/v17-preview-delta-2026-04-22.md
 *
 * v17 deltas vs the previous CreatorHeroPage.tsx:
 *   - Drop the "Vibe-coding speed. Production-grade safety." kicker from hero (dropped 2026-04-22).
 *   - CTAs: [Try an app] (accent) + [Publish your app] (ink). No docs button in hero.
 *   - Works-with belt moves DIRECTLY under CTAs with six explicit items.
 *   - Add a compact CLI reference strip ("/floom-deploy", "floom deploy").
 *   - Add a Publish-CTA box (accent btn + Read the protocol + "open source · MIT").
 *   - Add biz/teams card (live preview only had the vibecoder card).
 *   - Pricing teaser = single $0 card + 3 limit cells (no Pro/Team grid).
 *   - Hero demo column renders <HeroDemo /> — interactive 3-state
 *     build/deploy/use loop per HERO-DEMO-SPEC.md.
 *
 * The existing CreatorHeroPage.tsx is kept in the tree for reference;
 * main.tsx wires "/" to this page.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Code2, Rocket, Share2 } from 'lucide-react';

import { TopBar } from '../components/TopBar';
import { PublicFooter } from '../components/public/PublicFooter';
import { AppStripe } from '../components/public/AppStripe';
import { AppShowcaseCard } from '../components/public/AppShowcaseCard';
import { FeedbackButton } from '../components/FeedbackButton';

import { WorksWithBelt } from '../components/home/WorksWithBelt';
import { CliReference } from '../components/home/CliReference';
import { PublishCtaBox } from '../components/home/PublishCtaBox';
import { DualAudiences } from '../components/home/DualAudiences';
import { PricingTeaser } from '../components/home/PricingTeaser';
import { HeroDemo } from '../components/home/HeroDemo';
import { SectionEyebrow } from '../components/home/SectionEyebrow';
import { WorkedExample } from '../components/home/WorkedExample';
import { ThreeSurfacesDiagram } from '../components/home/ThreeSurfacesDiagram';
import { FitBand } from '../components/home/FitBand';
import { WhosBehind } from '../components/home/WhosBehind';
import { DiscordCta } from '../components/home/DiscordCta';

import * as api from '../api/client';
import type { HubApp } from '../lib/types';
import { publicHubApps } from '../lib/hub-filter';
import { readDeployEnabled, useDeployEnabled } from '../lib/flags';
import { waitlistHref } from '../lib/waitlistCta';
import { useSession } from '../hooks/useSession';

// MVP hero install snippet — generic MCP config, no per-app slug.
// IMPORTANT: use the current origin so tokens minted on mvp.floom.dev /
// v26.floom.dev / floom.dev (post-flip) point at the SAME host they were
// minted on. Hardcoding floom.dev breaks the 401-on-cross-host case.
const MCP_HOST = typeof window !== 'undefined' ? window.location.origin : 'https://floom.dev';
const MVP_MCP_SNIPPET = `{
  "mcpServers": {
    "floom": {
      "url": "${MCP_HOST}/mcp",
      "headers": {
        "Authorization": "Bearer floom_agent_<your_token>"
      }
    }
  }
}`;

function MvpHeroInstall() {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(MVP_MCP_SNIPPET);
      } else {
        const ta = document.createElement('textarea');
        ta.value = MVP_MCP_SNIPPET;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* silent */ }
  }
  return (
    <div style={{ maxWidth: 480, margin: '20px auto 0', textAlign: 'left' }}>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px', textAlign: 'center' }}>
        Paste in your MCP client config:
      </p>
      <div style={{ position: 'relative' }}>
        {/* F7 (2026-04-28): copy boxes use light tinted bg (var(--studio)),
            not dark. Federico-locked global rule. */}
        <pre
          data-testid="hero-mcp-snippet"
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 11,
            background: 'var(--studio, #f5f4f0)',
            color: 'var(--ink)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: '10px 12px',
            paddingRight: 64,
            overflowX: 'auto',
            whiteSpace: 'pre',
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {MVP_MCP_SNIPPET}
        </pre>
        <button
          type="button"
          data-testid="install-copy-btn"
          onClick={() => void handleCopy()}
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            fontSize: 11,
            fontWeight: 600,
            color: copied ? 'var(--muted)' : 'var(--accent)',
            background: 'var(--card)',
            border: `1px solid ${copied ? 'var(--line)' : 'rgba(4,120,87,0.35)'}`,
            borderRadius: 6,
            padding: '3px 10px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.03em',
          }}
          aria-label={copied ? 'Copied' : 'Copy MCP config'}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '10px 0 0', textAlign: 'center' }}>
        Need a token?{' '}
        <Link to="/signup" style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}>
          Sign up to get one
        </Link>
        {' '}→
      </p>
    </div>
  );
}

interface Stripe {
  slug: string;
  name: string;
  description: string;
  category?: string;
}

// Same showcase roster as CreatorHeroPage (P0 launch curation #253).
// 2026-04-25 roster swap: bounded <5s demos replaced the heavy originals.
const PREFERRED_SLUGS = ['competitor-lens', 'ai-readiness-audit', 'pitch-coach'] as const;

// Fallback descriptions rendered if /api/hub is slow or empty on cold
// visits. Match the 2026-04-25 launch roster. Keep tight + benefit-led.
const FALLBACK_STRIPES: Stripe[] = [
  {
    slug: 'competitor-lens',
    name: 'Competitor Lens',
    description: 'Paste 2 URLs — yours + a competitor. Get a positioning, pricing, and angle diff in under 5 seconds.',
    category: 'research',
  },
  {
    slug: 'ai-readiness-audit',
    name: 'AI Readiness Audit',
    description: 'Paste one URL. Get a readiness score 0-10, three risks, three opportunities, and one concrete next step.',
    category: 'research',
  },
  {
    slug: 'pitch-coach',
    name: 'Pitch Coach',
    description: 'Paste a startup pitch. Get three direct critiques, three angle-specific rewrites, and a one-line TL;DR.',
    category: 'writing',
  },
];

function pickStripes(apps: HubApp[]): Stripe[] {
  if (apps.length === 0) return FALLBACK_STRIPES;
  const bySlug = new Map(apps.map((app) => [app.slug, app]));
  const picked: Stripe[] = [];
  for (const slug of PREFERRED_SLUGS) {
    const hit = bySlug.get(slug);
    if (hit) picked.push({ slug: hit.slug, name: hit.name, description: hit.description, category: hit.category ?? undefined });
  }
  if (picked.length === PREFERRED_SLUGS.length) return picked;
  return picked.length >= 3 ? picked : FALLBACK_STRIPES;
}

interface LandingV17PageProps {
  variant?: 'full' | 'mvp';
}

export function LandingV17Page({ variant = 'full' }: LandingV17PageProps = {}) {
  const isMvp = variant === 'mvp';
  const [stripes, setStripes] = useState<Stripe[]>(FALLBACK_STRIPES);
  // G9 (2026-04-28): inline directory grid on MVP landing. Next 6 apps
  // after the 3 curated showcase slugs, plus a "Browse all <N> apps" CTA.
  // Federico: "we should still, on the MVP Floom, have the app store
  // visible, right?"
  const [directoryApps, setDirectoryApps] = useState<Stripe[]>([]);
  const [totalAppsCount, setTotalAppsCount] = useState<number>(0);
  const deployEnabledFlag = useDeployEnabled();
  const deployEnabled = deployEnabledFlag ?? readDeployEnabled();
  // v26 §3 option C: logged-in-aware landing.
  // When authenticated user hits "/", show a "Resume in {workspaceName} →" banner.
  const { data: session, isAuthenticated } = useSession();
  const waitlistHeroHref = useMemo(() => waitlistHref('landing-hero'), []);
  // Route both modes to /install-in-claude (the 4-tab Claude install flow).
  // /install is self-host Docker docs, /install/lead-scorer 404s when the
  // hub misses the row — neither matches the "Run in Claude" CTA text.
  // /install-in-claude renders without a slug (MCP search endpoint fallback)
  // so it can't dead-end.
  const runInClaudeHref = '/install-in-claude';

  useEffect(() => {
    document.title = 'Ship AI apps fast · Floom';
    api
      .getHub()
      .then((apps) => {
        const visible = publicHubApps(apps);
        if (visible.length > 0) {
          setStripes(pickStripes(visible));
          setTotalAppsCount(visible.length);
          // Pick the next 6 apps that aren't already in the curated showcase.
          const curatedSlugs = new Set<string>(PREFERRED_SLUGS as readonly string[]);
          const rest = visible
            .filter((app) => !curatedSlugs.has(app.slug))
            .slice(0, 6)
            .map((app) => ({
              slug: app.slug,
              name: app.name,
              description: app.description,
              category: app.category ?? undefined,
            }));
          setDirectoryApps(rest);
        }
      })
      .catch(() => {
        // Keep static roster on failure.
      });
  }, []);

  return (
    <div
      className="page-root landing-v17"
      data-testid="landing-v17"
      style={{ minHeight: '100vh', background: 'var(--bg)' }}
    >
      <TopBar />

      {/* v26 §3 option C: resume banner for authenticated users.
          G1 (2026-04-28): slimmed to a 1-line stripe so it doesn't
          compete with the hero. Federico: "the composition still is
          a bit overwhelming". */}
      {isAuthenticated && session && (
        <div
          data-testid="landing-resume-banner"
          style={{
            background: 'var(--studio, #f5f4f0)',
            borderBottom: '1px solid var(--line)',
            padding: '6px 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontSize: 12.5,
            lineHeight: 1.4,
          }}
        >
          <span style={{ color: 'var(--muted)' }}>
            You're signed in.
          </span>
          <Link
            to="/run/apps"
            data-testid="landing-resume-cta"
            style={{
              fontWeight: 600,
              color: 'var(--accent)',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            Resume in{' '}
            {session.active_workspace?.name?.trim() || 'your workspace'} →
          </Link>
        </div>
      )}

      <main id="main" style={{ display: 'block' }}>
        {/* HERO — wireframe: .hero-shell > .hero
            Cursor-style layout (Federico 2026-04-23 — "the visual demo
            doesn't have to fit on the hero in full"). Above the fold at
            1440x900: eyebrow + H1 + sub + CTA + top ~120-150px of the
            HeroDemo canvas. The rest of the demo extends below the fold and
            reveals on scroll — no min-height:100vh forcing fit, no squished
            demo. Top padding trimmed (40 -> 24) to give the canvas more room
            inside the first viewport. */}
        <section
          data-testid="hero"
          style={{
            position: 'relative',
            padding: isMvp ? '64px 24px 56px' : '24px 24px 40px',
            borderBottom: '1px solid var(--line)',
            background:
              'linear-gradient(180deg, var(--card) 0%, var(--bg) 100%)',
          }}
        >
          <div
            style={{
              maxWidth: 980,
              margin: '0 auto',
              textAlign: 'center',
            }}
          >
            {/* G1 (2026-04-28): hero composition. Federico said the hero
                still felt overwhelming. Solution:
                - Lift "Backed by Founders Inc" ABOVE H1 as a quiet eyebrow
                  (positions the product, doesn't compete with the H1)
                - Add vertical breathing room around H1 + sub
                - Demote WorksWithBelt to a soft caption under the snippet
                - Resume banner slimmed to a 1-line stripe (above) */}
            {isMvp && (
              <p
                data-testid="hero-backed-by"
                style={{
                  margin: '0 auto 28px',
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  letterSpacing: '0.10em',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  textAlign: 'center',
                }}
              >
                Backed by{' '}
                <a
                  href="https://f.inc"
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: 'var(--ink)',
                    fontWeight: 700,
                    textDecoration: 'none',
                  }}
                >
                  Founders Inc
                </a>
              </p>
            )}
            {!isMvp && (
              <div style={{ marginTop: 24 }}>
                <WorksWithBelt />
              </div>
            )}

            {/* H1 — locked copy. Wireframe ships 64px desktop, balance wrap.
                F10 (2026-04-28): "fast" coloured with brand green for emphasis. */}
            <h1
              className="hero-headline"
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 64,
                lineHeight: 1.02,
                letterSpacing: '-0.025em',
                color: 'var(--ink)',
                margin: isMvp ? '0 0 20px' : '0 0 16px',
                textWrap: 'balance' as unknown as 'balance',
              }}
            >
              Ship AI apps <span style={{ color: 'var(--accent)' }}>fast</span>.
            </h1>

            {/* Sub-positioning — locked copy. NO KICKER (dropped 2026-04-22). */}
            <p
              className="hero-sub"
              data-testid="hero-sub-positioning"
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 19,
                lineHeight: 1.5,
                fontWeight: 400,
                color: 'var(--muted)',
                maxWidth: 640,
                margin: isMvp ? '0 auto 36px' : '0 auto 28px',
              }}
            >
              The protocol + runtime for agentic work.
            </p>
            {!isMvp && (
              <p style={{ fontSize: 15, fontWeight: 800, color: 'var(--accent)', margin: '-14px 0 28px' }}>
                Vibe-coding speed. Production-grade safety.
              </p>
            )}

            {/* CTA — MVP variant: inline MCP setup snippet.
                Full variant: runtime-gated by DEPLOY_ENABLED. */}
            {isMvp ? (
              <>
                <MvpHeroInstall />
                {/* G1 (2026-04-28): WorksWithBelt as a soft caption under
                    the snippet — visually subdued (small + reduced
                    opacity) so it reads as "and works with these
                    clients" rather than another heavy element competing
                    with H1+snippet. */}
                <div style={{ marginTop: 28, opacity: 0.85 }}>
                  <WorksWithBelt />
                </div>
              </>
            ) : (
            <div
              className="hero-ctas"
              style={{
                display: 'flex',
                flexDirection: deployEnabled ? 'column' : 'row',
                alignItems: 'center',
                justifyContent: 'center',
                flexWrap: 'wrap',
                gap: deployEnabled ? 10 : 12,
                marginBottom: 4,
              }}
            >
              {!deployEnabled && (
                <Link
                  to={waitlistHeroHref}
                  data-testid="hero-cta-deploy"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    background: 'var(--ink)',
                    color: '#fff',
                    border: '1px solid var(--ink)',
                    borderRadius: 999,
                    padding: '14px 26px',
                    fontSize: 15,
                    fontWeight: 600,
                    textDecoration: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Join the waitlist
                </Link>
              )}
              <Link
                to={runInClaudeHref}
                data-testid="hero-cta-run-in-claude"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  background: deployEnabled ? 'var(--ink)' : 'var(--card)',
                  color: deployEnabled ? '#fff' : 'var(--ink)',
                  border: `1px solid ${deployEnabled ? 'var(--ink)' : 'var(--line)'}`,
                  borderRadius: 999,
                  padding: deployEnabled ? '14px 24px' : '13px 18px',
                  fontSize: 15,
                  fontWeight: 600,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {'Run in your AI tool'}
              </Link>
              {deployEnabled && (
                <Link
                  to="/signup"
                  data-testid="hero-cta-deploy"
                  style={{
                    fontSize: 13,
                    color: 'var(--muted)',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  Deploy your own
                  <ArrowRight size={13} aria-hidden="true" />
                </Link>
              )}
            </div>
            )}
          </div>

          {/* Hero demo — interactive 3-state build/deploy/use loop.
              Sits directly under the CTAs. Sized to 580px (Cursor-style,
              Federico 2026-04-23): top ~120-150px is visible above the fold
              at 1440x900, rest scrolls into view. Bigger canvas = more
              cinematic, no squishing to fit the viewport.
              MVP variant: KEEP (Federico 2026-04-28 — visual hero asset
              is essential, install snippet sits below it not instead). */}
          <HeroDemo />
        </section>

        {/* Compact CLI reference strip below the hero — smaller than the
            original hero-inline version (Federico 2026-04-23 — moved out of
            hero, kept below as a smaller block).
            MVP variant: dropped (technical → /docs). */}
        {!isMvp && (
          <section
            data-testid="cli-reference-section"
            style={{ padding: '32px 24px 8px' }}
          >
            <CliReference />
          </section>
        )}

        {/* HOW IT WORKS — 3 steps */}
        <section
          data-testid="how-it-works"
          style={{ padding: '72px 28px', maxWidth: 1240, margin: '0 auto' }}
        >
          <SectionEyebrow>How it works</SectionEyebrow>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 800,
              fontSize: 34,
              lineHeight: 1.1,
              letterSpacing: '-0.025em',
              textAlign: 'center',
              margin: '0 auto 28px',
              maxWidth: 760,
            }}
          >
            From idea to shipped app in 3 steps.
          </h2>
          <div
            className="steps"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 18,
              maxWidth: 1180,
              margin: '0 auto',
            }}
          >
            {STEPS.map((s, idx) => {
              const Icon = idx === 0 ? Code2 : idx === 1 ? Rocket : Share2;
              return (
              <div
                key={s.num}
                className="step"
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: '24px 22px',
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    background: 'rgba(4,120,87,0.08)',
                    border: '1px solid rgba(4,120,87,0.18)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#047857',
                    marginBottom: 16,
                  }}
                >
                  <Icon size={22} strokeWidth={1.6} />
                </div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontSize: 11,
                    color: 'var(--muted)',
                    letterSpacing: '0.08em',
                    fontWeight: 600,
                    marginBottom: 12,
                  }}
                >
                  {s.num} &middot; {s.kicker}
                </div>
                <h3
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    margin: '0 0 8px',
                    lineHeight: 1.3,
                  }}
                >
                  {s.title}
                </h3>
                <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, margin: 0 }}>
                  {s.body}
                </p>
                <div
                  style={{
                    marginTop: 14,
                    paddingTop: 14,
                    borderTop: '1px solid var(--line)',
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontSize: 11.5,
                    color: 'var(--muted)',
                  }}
                >
                  {s.mono}
                </div>
              </div>
            );
            })}
          </div>
        </section>

        {/* WORKED EXAMPLE — MVP variant: dropped (heavy). */}
        {!isMvp && <WorkedExample />}

        {/* THREE SURFACES DIAGRAM — MVP variant: dropped (technical → /docs). */}
        {!isMvp && <ThreeSurfacesDiagram />}

        {/* FIT BAND — MVP variant: dropped (qualifying). */}
        {!isMvp && <FitBand />}

        {/* SHOWCASE — 3 apps */}
        <section
          data-testid="showcase"
          style={{
            padding: '72px 28px',
            maxWidth: 1240,
            margin: '0 auto',
            borderTop: '1px solid var(--line)',
          }}
        >
          <SectionEyebrow>Showcase</SectionEyebrow>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 800,
              fontSize: 34,
              lineHeight: 1.1,
              letterSpacing: '-0.025em',
              textAlign: 'center',
              margin: '0 auto 10px',
              maxWidth: 760,
            }}
          >
            Three apps Floom already runs in production.
          </h2>
          <p
            style={{
              fontSize: 15.5,
              color: 'var(--muted)',
              textAlign: 'center',
              maxWidth: 620,
              margin: '0 auto 40px',
            }}
          >
            Real AI doing real work. All three deploy from a single GitHub repo.
          </p>
          {/* G3 (2026-04-28): app-store-style cards. Federico: "the apps
              on the landing page should be cards, like on the app store.
              Right now they are just small boxes." Replaces horizontal
              AppStripe (icon-text-arrow row) with vertical AppShowcaseCard
              for the MVP showcase: prominent icon tile, bold name, tagline,
              category pill + Try CTA. 3-up desktop, 2-up tablet, 1-up mobile. */}
          <div className="mvp-showcase-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18, maxWidth: 1100, margin: '0 auto' }}>
            {isMvp
              ? stripes.map((s) => (
                  <AppShowcaseCard
                    key={s.slug}
                    slug={s.slug}
                    name={s.name}
                    description={s.description}
                    category={s.category}
                  />
                ))
              : stripes.map((s) => (
                  <AppStripe
                    key={s.slug}
                    slug={s.slug}
                    name={s.name}
                    description={s.description}
                    category={s.category}
                    variant="landing"
                  />
                ))}
          </div>
          <style>{`
            @media (max-width: 880px) {
              .mvp-showcase-grid { grid-template-columns: repeat(2, 1fr) !important; }
            }
            @media (max-width: 640px) {
              .mvp-showcase-grid { grid-template-columns: 1fr !important; }
            }
          `}</style>
        </section>

        {/* G9 (2026-04-28): inline app-directory grid on MVP landing.
            Curated showcase above is the editorial pick (3 demo-ready
            apps). This section surfaces the rest of the directory inline
            so visitors see the full breadth without leaving the page,
            then a prominent CTA links to `/apps` for the full directory.
            Federico: "we should still, on the MVP Floom, have the app
            store visible, right? What speaks against it? Already works." */}
        {isMvp && directoryApps.length > 0 && (
          <section
            data-testid="mvp-directory-section"
            style={{ padding: '24px 28px 64px', maxWidth: 1240, margin: '0 auto' }}
          >
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 24,
                lineHeight: 1.15,
                letterSpacing: '-0.025em',
                textAlign: 'center',
                margin: '0 auto 8px',
                maxWidth: 760,
              }}
            >
              Or browse the full directory.
            </h2>
            <p
              style={{
                fontSize: 14.5,
                color: 'var(--muted)',
                textAlign: 'center',
                maxWidth: 620,
                margin: '0 auto 32px',
                lineHeight: 1.55,
              }}
            >
              {totalAppsCount > 0
                ? `${totalAppsCount} apps live on Floom. All MIT-licensed, all self-hostable.`
                : 'All MIT-licensed, all self-hostable.'}
            </p>
            <div
              className="mvp-directory-grid"
              data-testid="mvp-directory-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 16,
                maxWidth: 1100,
                margin: '0 auto 28px',
              }}
            >
              {directoryApps.map((app) => (
                <AppShowcaseCard
                  key={app.slug}
                  slug={app.slug}
                  name={app.name}
                  description={app.description}
                  category={app.category}
                />
              ))}
            </div>
            <div style={{ textAlign: 'center' }}>
              <Link
                to="/apps"
                data-testid="mvp-directory-cta"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'var(--accent)',
                  color: '#fff',
                  border: '1px solid var(--accent)',
                  borderRadius: 10,
                  padding: '11px 18px',
                  fontSize: 13.5,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                {totalAppsCount > 0 ? `Browse all ${totalAppsCount} apps` : 'Browse all apps'}
                <span aria-hidden="true">→</span>
              </Link>
            </div>
            <style>{`
              @media (max-width: 880px) {
                .mvp-directory-grid { grid-template-columns: repeat(2, 1fr) !important; }
              }
              @media (max-width: 640px) {
                .mvp-directory-grid { grid-template-columns: 1fr !important; }
              }
            `}</style>
          </section>
        )}

        {/* PUBLISH-CTA BOX — MVP variant: dropped (creator-focused, MVP is consumer-first). */}
        {!isMvp && (
          <section style={{ padding: '24px 28px', maxWidth: 1240, margin: '0 auto' }}>
            <PublishCtaBox />
          </section>
        )}

        {/* DUAL AUDIENCES — MVP variant: dropped (heavy split). */}
        {!isMvp && <DualAudiences />}

        {/* PRICING TEASER — MVP variant: dropped (no pricing). */}
        {!isMvp && <PricingTeaser />}

        {/* BUILD CTA — MVP variant: dropped (creator-focused). */}
        {!isMvp && (
          <section
            style={{
              padding: '72px 28px',
              maxWidth: 760,
              margin: '0 auto',
              textAlign: 'center',
            }}
          >
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 26,
                lineHeight: 1.1,
                letterSpacing: '-0.025em',
                margin: '0 0 8px',
              }}
            >
              Want to build yours?
            </h2>
            <p style={{ fontSize: 15.5, color: 'var(--muted)', margin: '0 0 24px', lineHeight: 1.55 }}>
              The protocol is 40 lines of JSON. The docs walk you through your
              first deploy in under 10 minutes.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link
                to="/docs"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  background: 'var(--accent)',
                  color: '#fff',
                  border: '1px solid var(--accent)',
                  borderRadius: 10,
                  padding: '11px 17px',
                  fontSize: 13.5,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Open the docs
              </Link>
              <a
                href="https://github.com/floomhq/floom"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  background: 'var(--card)',
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: '11px 17px',
                  fontSize: 13.5,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Star on GitHub
              </a>
            </div>
          </section>
        )}

        {/* WHO'S BEHIND IT — MVP variant: dropped (→ /about). */}
        {!isMvp && <WhosBehind />}

        {/* DISCORD CTA — quiet chip above the footer (#613,
            Federico 2026-04-23). Invite lives in MEMORY
            (project_floom_discord): https://discord.gg/8fXGXjxcRz. Not
            a second hero, just a visible path for visitors who want
            to talk to the team or other builders. */}
        <DiscordCta />
      </main>

      <PublicFooter />
      <FeedbackButton />

    </div>
  );
}

const STEPS = [
  {
    num: '01',
    kicker: 'BRING YOUR APP',
    title: 'Got an idea or a GitHub link?',
    body: 'Paste it. Floom takes care of the rest.',
    mono: 'paste anything',
  },
  {
    num: '02',
    kicker: 'GO LIVE',
    title: '60 seconds later, your app is live',
    body: 'You get a public URL, an AI-tool plugin, and an API. No setup.',
    mono: 'live in ~60s',
  },
  {
    num: '03',
    kicker: 'SHARE ANYWHERE',
    title: 'Send the link.',
    body: 'People run your app from any MCP client, browser, or with curl.',
    mono: 'one link, every tool',
  },
];
