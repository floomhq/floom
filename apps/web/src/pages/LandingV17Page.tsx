/**
 * LandingV17Page — marketing home `/` rebuilt to the v17 wireframes.
 *
 * 2026-04-27 waitlist-reality rewrite:
 *   floom.dev (production) is waitlist-only for the build/deploy flow, but
 *   the 3 featured apps (Lead Scorer, Resume Ranker, Competitor Analyzer)
 *   are live and runnable today. preview.floom.dev keeps the full flow.
 *   This file is re-framed so it never visually promises "instant deploy"
 *   on prod while still being exciting:
 *     - Hero CTAs: [Try an app] primary, [Join the waitlist] secondary.
 *     - Hero demo: 2-state (build -> use) driven by `DEPLOY_ENABLED` flag.
 *     - New "Try these 3 apps" row right under the hero demo.
 *     - "Deploy your own" collapses into the waitlist CTA.
 *     - Every deploy/publish CTA across the page reacts to DEPLOY_ENABLED.
 *   When `VITE_DEPLOY_ENABLED=true` (preview + post-launch), copy reverts
 *   to the original Deploy-forward phrasing.
 *
 * Sources of truth:
 *   /var/www/wireframes-floom/v17/landing.html            (desktop)
 *   /var/www/wireframes-floom/v17/landing-mobile.html     (mobile)
 *   /var/www/wireframes-floom/v17/REVISION-2026-04-22.md  (latest revisions)
 *   /root/floom-internal/launch/v17-preview-delta-2026-04-22.md
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

import { TopBar } from '../components/TopBar';
import { PublicFooter } from '../components/public/PublicFooter';
import { AppStripe } from '../components/public/AppStripe';
import { FeedbackButton } from '../components/FeedbackButton';

import { WorksWithBelt } from '../components/home/WorksWithBelt';
import { CliReference } from '../components/home/CliReference';
import { PublishCtaBox } from '../components/home/PublishCtaBox';
import { DualAudiences } from '../components/home/DualAudiences';
import { PricingTeaser } from '../components/home/PricingTeaser';
import { HeroDemo } from '../components/home/HeroDemo';
import { SectionEyebrow } from '../components/home/SectionEyebrow';
import { TryTheseApps } from '../components/home/TryTheseApps';

import * as api from '../api/client';
import type { HubApp } from '../lib/types';
import { publicHubApps } from '../lib/hub-filter';
import { DEPLOY_ENABLED, useDeployEnabled } from '../lib/flags';
import { WaitlistModal } from '../components/WaitlistModal';

interface Stripe {
  slug: string;
  name: string;
  description: string;
  category?: string;
}

// Same showcase roster as CreatorHeroPage (see P0 launch curation #253).
const PREFERRED_SLUGS = ['lead-scorer', 'competitor-analyzer', 'resume-screener'] as const;

const FALLBACK_STRIPES: Stripe[] = [
  {
    slug: 'lead-scorer',
    name: 'Lead Scorer',
    description: 'Upload a CSV of leads + your ICP. Get fit scores, reasoning, and enriched columns.',
    category: 'growth',
  },
  {
    slug: 'competitor-analyzer',
    name: 'Competitor Analyzer',
    description: 'Paste competitor URLs, get positioning, pricing, and a strengths/weaknesses table.',
    category: 'research',
  },
  {
    slug: 'resume-screener',
    name: 'Resume Screener',
    description: 'Upload a zip of PDFs + a JD, get a ranked shortlist with reasoning per candidate.',
    category: 'growth',
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

export function LandingV17Page() {
  const [stripes, setStripes] = useState<Stripe[]>(FALLBACK_STRIPES);
  // Launch feature flag (2026-04-27). When false, the secondary
  // "Deploy your own" hero link swaps to a "Join waitlist" button that
  // opens WaitlistModal instead of navigating to /signup.
  const deployEnabled = useDeployEnabled();
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  useEffect(() => {
    document.title = 'Ship AI apps fast · Floom';
    api
      .getHub()
      .then((apps) => {
        const visible = publicHubApps(apps);
        if (visible.length > 0) setStripes(pickStripes(visible));
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
            padding: '24px 24px 40px',
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
            {/* Works-with belt as small eyebrow ABOVE the H1
                (Federico 2026-04-23 — "like we had before"). */}
            <WorksWithBelt />

            {/* H1 — "AI apps you can ship as easily as you write a prompt."
                (2026-04-27 waitlist-reality pick, see PR body for rationale).
                The old "Ship AI apps fast." is still true on preview but on
                prod the ship-verb needs softening when Deploy is gated; this
                reframe keeps the excitement ("as easily as you write a
                prompt") while letting the page tell the whole truth below. */}
            <h1
              className="hero-headline"
              style={{
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontWeight: 400,
                fontSize: 64,
                lineHeight: 1.02,
                letterSpacing: '-0.025em',
                color: 'var(--ink)',
                margin: '0 0 16px',
                textWrap: 'balance' as unknown as 'balance',
              }}
            >
              AI apps you can <span style={{ color: 'var(--accent)' }}>ship</span>
              {' '}as easily as you write a prompt.
            </h1>

            <p
              className="hero-sub"
              data-testid="hero-sub-positioning"
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: 19,
                lineHeight: 1.45,
                fontWeight: 400,
                color: 'var(--muted)',
                maxWidth: 640,
                margin: '0 auto 28px',
              }}
            >
              The protocol and runtime for agentic work.
            </p>

            {/* CTA — waitlist-reality pair.
                Primary: [Try an app] -> /store (directs into the 3 live
                  featured apps; the hero demo itself is running one).
                Secondary: [Join the waitlist] opens the waitlist modal so
                  makers who want to ship their OWN app are captured at the
                  right emotional moment. Reverts to the Deploy-forward pair
                  when DEPLOY_ENABLED flips on. */}
            <div
              className="hero-ctas"
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                flexWrap: 'wrap',
                gap: 12,
                marginBottom: 4,
              }}
            >
              <Link
                to="/apps"
                data-testid="hero-cta-try-app"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  background: 'var(--ink)',
                  color: '#fff',
                  border: '1px solid var(--ink)',
                  borderRadius: 999,
                  padding: '14px 24px',
                  fontSize: 15,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Try an app
                <ArrowRight size={15} aria-hidden="true" />
              </Link>

              {deployEnabled === false ? (
                <button
                  type="button"
                  data-testid="hero-cta-waitlist"
                  onClick={() => setWaitlistOpen(true)}
                  style={{ ...HERO_GHOST_STYLE, cursor: 'pointer' }}
                >
                  Join the waitlist to build your own
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              ) : (
                <Link
                  to="/signup"
                  data-testid="hero-cta-deploy"
                  style={HERO_GHOST_STYLE}
                >
                  Deploy your own
                  <ArrowRight size={14} aria-hidden="true" />
                </Link>
              )}
            </div>
          </div>

          {/* Hero demo — morphing canvas. `build -> use` (2-state) by default
              under waitlist; flips to the full `build -> deploy -> use` loop
              on preview / post-launch via DEPLOY_ENABLED. The Use state
              shows Lead Scorer (the most universally appealing of the three
              featured apps) returning a real fit score. */}
          <HeroDemo />

          {/* "Deploy your own" — compact tile directly under the demo.
              This is where the Deploy moment narrative lives now that the
              demo itself no longer animates it. One sentence + waitlist CTA
              on prod; swaps to a plain Deploy CTA when DEPLOY_ENABLED is on. */}
          <DeployYourOwnTile onWaitlist={() => setWaitlistOpen(true)} />
        </section>

        {/* "Try these 3 apps" — 3 side-by-side cards of the live featured
            apps. Placed strategically just below the hero, BEFORE the "how
            it works" narrative, so the page delivers a usable product (not
            a promise) in the first scroll. 2026-04-27 launch-strategy pivot. */}
        <TryTheseApps />

        {/* Compact CLI reference strip below the hero. Docs/informational —
            not an action CTA, so it stays put regardless of DEPLOY_ENABLED
            (the slash command IS the integration even while the public deploy
            flow is gated — self-hosters and MCP builders use it today). */}
        <section
          data-testid="cli-reference-section"
          style={{ padding: '16px 24px 8px' }}
        >
          <CliReference />
        </section>

        {/* HOW IT WORKS — 3 steps */}
        <section
          data-testid="how-it-works"
          style={{ padding: '72px 28px', maxWidth: 1240, margin: '0 auto' }}
        >
          <SectionEyebrow>How it works</SectionEyebrow>
          <h2
            style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontWeight: 400,
              fontSize: 34,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
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
            {STEPS.map((s) => (
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
            ))}
          </div>
        </section>

        {/* SHOWCASE (vertical stripes) — kept only when DEPLOY_ENABLED.
            On waitlist-prod the 3 featured apps are already surfaced as the
            top-of-page <TryTheseApps /> cards, so this section duplicates
            them. On preview / post-launch it reappears because the "three
            apps Floom runs in production" narrative reinforces the deploy
            claim. 2026-04-27 launch-reality pivot. */}
        {DEPLOY_ENABLED && (
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
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontWeight: 400,
                fontSize: 34,
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
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
            <div style={{ display: 'grid', gap: 12, maxWidth: 820, margin: '0 auto' }}>
              {stripes.map((s) => (
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
          </section>
        )}

        {/* PUBLISH-CTA BOX */}
        <section style={{ padding: '24px 28px', maxWidth: 1240, margin: '0 auto' }}>
          <PublishCtaBox />
        </section>

        {/* DUAL AUDIENCES — makers + teams */}
        <DualAudiences />

        {/* PRICING TEASER — single $0 card */}
        <PricingTeaser />

        {/* FINAL CTA — docs + GitHub stay put (informational CTAs, not
            deploy promises). Where there was previously an implicit "deploy
            your first app" framing, the copy now leans on "join the waitlist"
            on prod. Reverts when DEPLOY_ENABLED is on. */}
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
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontWeight: 400,
              fontSize: 26,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              margin: '0 0 8px',
            }}
          >
            {DEPLOY_ENABLED ? 'Want to build yours?' : 'Want to build your own?'}
          </h2>
          <p style={{ fontSize: 15.5, color: 'var(--muted)', margin: '0 0 24px', lineHeight: 1.55 }}>
            {DEPLOY_ENABLED
              ? 'The protocol is 40 lines of JSON. The docs walk you through your first deploy in under 10 minutes.'
              : 'The protocol is 40 lines of JSON and open source today. Join the waitlist to deploy on the hosted runtime, or self-host right now with one Docker command.'}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            {DEPLOY_ENABLED ? null : (
              <button
                type="button"
                data-testid="final-cta-waitlist"
                onClick={() => setWaitlistOpen(true)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  background: 'var(--ink)',
                  color: '#fff',
                  border: '1px solid var(--ink)',
                  borderRadius: 10,
                  padding: '11px 17px',
                  fontSize: 13.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: "'Inter', system-ui, sans-serif",
                }}
              >
                Join the waitlist
              </button>
            )}
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
      </main>

      <PublicFooter />
      <FeedbackButton />

      <WaitlistModal
        open={waitlistOpen}
        onClose={() => setWaitlistOpen(false)}
        source="hero"
      />

      {/* Responsive tweaks: hero typography + stacking */}
      <style>{`
        @media (max-width: 1040px) {
          .landing-v17 .hero-headline { font-size: 56px !important; }
          .landing-v17 .steps { grid-template-columns: 1fr !important; gap: 14px !important; }
        }
        @media (max-width: 780px) {
          .landing-v17 .hero-headline { font-size: 44px !important; }
          .landing-v17 .hero-sub { font-size: 16px !important; }
        }
        @media (max-width: 640px) {
          .landing-v17 [data-testid="hero"] { padding: 24px 16px 28px !important; }
          .landing-v17 .hero-headline { font-size: 34px !important; line-height: 1.06 !important; }
          .landing-v17 .hero-sub { font-size: 15px !important; margin-bottom: 20px !important; }
          .landing-v17 .hero-ctas { flex-direction: column !important; align-items: stretch !important; gap: 8px !important; }
          .landing-v17 .hero-ctas a, .landing-v17 .hero-ctas button { width: 100% !important; }
          .landing-v17 .hero-ctas a[data-testid="hero-cta-try-app"] { padding: 14px 20px !important; }
          .landing-v17 .hero-ctas a[data-testid="hero-cta-deploy"] { padding: 10px 12px !important; min-height: 44px !important; justify-content: center !important; }
          .landing-v17 .hero-ctas button[data-testid="hero-cta-waitlist"] { padding: 10px 12px !important; min-height: 44px !important; justify-content: center !important; }
          .landing-v17 .works-with { gap: 16px 24px !important; }
          .landing-v17 .dual { grid-template-columns: 1fr !important; }
          .landing-v17 .publish-cta { grid-template-columns: 1fr !important; text-align: left !important; }
          .landing-v17 .limits { grid-template-columns: 1fr !important; gap: 10px !important; text-align: left !important; }
          /* Shrink sections so 28px side padding + 34px H2 don't blow out
             the 375px viewport. Applies to every landing section that uses
             the default 72px/28px padding. */
          .landing-v17 main > section { padding-left: 20px !important; padding-right: 20px !important; }
          .landing-v17 main > section { padding-top: 48px !important; padding-bottom: 48px !important; }
          .landing-v17 [data-testid="hero"] { padding-top: 24px !important; padding-bottom: 28px !important; }
          .landing-v17 [data-testid="cli-reference-section"] { padding-top: 24px !important; padding-bottom: 8px !important; }
          /* Serif H2 across the page: scale down so long headlines don't
             overflow on narrow screens. 34->26, 28->24. */
          .landing-v17 main > section h2 { font-size: 26px !important; letter-spacing: -0.015em !important; }
          .landing-v17 [data-testid="pricing-teaser"] h2 { font-size: 24px !important; }
          /* Pricing card padding tightens so the $0 number stays centered. */
          .landing-v17 [data-testid="pricing-teaser"] > div > div:nth-child(2) { padding: 24px 18px 22px !important; }
          /* Build CTA buttons: stack full width and stay tap-friendly. */
          .landing-v17 main > section:last-of-type > div { flex-direction: column !important; align-items: stretch !important; }
          .landing-v17 main > section:last-of-type > div a { width: 100% !important; min-height: 44px !important; padding: 12px 18px !important; }
        }
      `}</style>
    </div>
  );
}

/**
 * Hero secondary CTA — ghost button. Pulled out of the JSX so both the
 * Deploy-forward and waitlist variants render identically. Sized a notch
 * smaller than the primary ink pill so the hierarchy is obvious.
 */
const HERO_GHOST_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  background: 'var(--card)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 999,
  padding: '12px 18px',
  fontSize: 14,
  fontWeight: 500,
  textDecoration: 'none',
  fontFamily: "'Inter', system-ui, sans-serif",
} as const;

/**
 * DeployYourOwnTile — compact "deploy the next app" block under the hero
 * demo. Replaces what the old hero demo used to show as its Deploy state
 * (the `/floomit` slash command and live URL line). Single sentence +
 * waitlist CTA; flips to a direct Deploy CTA when DEPLOY_ENABLED is on.
 */
function DeployYourOwnTile({ onWaitlist }: { onWaitlist: () => void }) {
  if (DEPLOY_ENABLED) {
    return (
      <div data-testid="deploy-your-own-tile" style={DEPLOY_TILE_STYLE}>
        <div style={DEPLOY_TILE_TEXT}>
          <strong style={DEPLOY_TILE_STRONG}>Deploy your own.</strong>
          <span style={DEPLOY_TILE_MUTED}>
            One slash command in Claude Code or{' '}
            <code style={DEPLOY_TILE_CODE}>floom deploy</code> from any terminal
            &mdash; live in ~60 seconds.
          </span>
        </div>
        <Link to="/signup" data-testid="deploy-tile-cta" style={DEPLOY_TILE_BTN}>
          Deploy your app
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    );
  }
  return (
    <div data-testid="deploy-your-own-tile" style={DEPLOY_TILE_STYLE}>
      <div style={DEPLOY_TILE_TEXT}>
        <strong style={DEPLOY_TILE_STRONG}>Deploy your own.</strong>
        <span style={DEPLOY_TILE_MUTED}>
          The public build-and-deploy flow is rolling out in waves. Join the
          waitlist and we&rsquo;ll let you in as soon as your slot opens.
        </span>
      </div>
      <button
        type="button"
        data-testid="deploy-tile-waitlist"
        onClick={onWaitlist}
        style={{ ...DEPLOY_TILE_BTN, cursor: 'pointer' }}
      >
        Join the waitlist
        <ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

const DEPLOY_TILE_STYLE = {
  marginTop: 24,
  maxWidth: 1080,
  marginLeft: 'auto',
  marginRight: 'auto',
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 14,
  padding: '16px 20px',
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  flexWrap: 'wrap' as const,
  justifyContent: 'space-between',
  textAlign: 'left' as const,
};

const DEPLOY_TILE_TEXT = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 2,
  minWidth: 260,
  flex: 1,
};

const DEPLOY_TILE_STRONG = {
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontSize: 18,
  fontWeight: 400,
  color: 'var(--ink)',
  letterSpacing: '-0.01em',
};

const DEPLOY_TILE_MUTED = {
  fontSize: 13.5,
  color: 'var(--muted)',
  lineHeight: 1.5,
};

const DEPLOY_TILE_CODE = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12,
  background: 'var(--studio)',
  padding: '1px 6px',
  borderRadius: 4,
  color: 'var(--ink)',
};

const DEPLOY_TILE_BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  background: 'var(--ink)',
  color: '#fff',
  border: '1px solid var(--ink)',
  borderRadius: 999,
  padding: '10px 18px',
  fontSize: 13.5,
  fontWeight: 600,
  textDecoration: 'none',
  fontFamily: "'Inter', system-ui, sans-serif",
  flexShrink: 0,
};

const STEPS = [
  {
    num: '01',
    kicker: 'WRITE',
    title: 'Write one JSON spec',
    body: 'Describe inputs, outputs, and the model call. No framework. No server code.',
    mono: 'spec.floom.json',
  },
  {
    num: '02',
    kicker: 'DEPLOY',
    title: 'Paste your GitHub URL',
    body: 'Floom builds, tests, and ships it to a public page, an MCP server, and a JSON API.',
    mono: 'git push \u2192 live in ~60s',
  },
  {
    num: '03',
    kicker: 'SHARE',
    title: 'Share a link. Install anywhere.',
    body: 'Runs in Claude, Cursor, ChatGPT, a browser, or behind an API key.',
    mono: 'floom.dev/a/your-app',
  },
];
