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
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { TopBar } from '../components/TopBar';
import { PublicFooter } from '../components/public/PublicFooter';
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
import { ShowcaseGridV23 } from '../components/home/ShowcaseGridV23';

import * as api from '../api/client';
import type { HubApp } from '../lib/types';
import { publicHubApps } from '../lib/hub-filter';
import { readDeployEnabled, useDeployEnabled } from '../lib/flags';
import { waitlistHref } from '../lib/waitlistCta';

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

export function LandingV17Page() {
  const [stripes, setStripes] = useState<Stripe[]>(FALLBACK_STRIPES);
  const deployEnabledFlag = useDeployEnabled();
  const deployEnabled = deployEnabledFlag ?? readDeployEnabled();
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
            {/* Launch week pill removed from landing (#669) — remains on
                /waitlist where it's route-scoped to the beta banner.
                Landing keeps the hero calm with just the works-with belt
                eyebrow + H1 + sub. The marginTop below restores the
                vertical breathing room the pill wrapper used to provide
                (Federico 2026-04-24 — "above ship ai apps fast we need
                margin again"). */}
            <div style={{ marginTop: 24 }}>
              <WorksWithBelt />
            </div>

            {/* H1 — locked copy. v23 ships clamp(44, 7vw, 72) desktop, balance wrap. */}
            <h1
              className="hero-headline"
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 'clamp(44px, 7vw, 72px)',
                lineHeight: 1.02,
                letterSpacing: '-0.025em',
                color: 'var(--ink)',
                margin: '0 0 16px',
                textWrap: 'balance' as unknown as 'balance',
              }}
            >
              Ship AI apps <span style={{ color: 'var(--accent)' }}>fast.</span>
            </h1>

            {/* Sub-positioning — locked copy. NO KICKER (dropped 2026-04-22).
                v23 lock: "+" not "and" (matches positioning memory). */}
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
              The protocol + runtime for agentic work.
            </p>

            {/* CTA — v23 lock: accent "Run in Claude" leads, ink secondary
                follows. Same hierarchy in both deploy + waitlist mode
                (try-the-product first, signup second). Matches the
                "free for launch, rate-limited not paywalled" positioning. */}
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
                to={runInClaudeHref}
                data-testid="hero-cta-run-in-claude"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  background: 'var(--accent)',
                  color: '#fff',
                  border: '1px solid var(--accent)',
                  borderRadius: 999,
                  padding: '14px 26px',
                  fontSize: 15,
                  fontWeight: 600,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                Run in Claude
              </Link>
              <Link
                to={deployEnabled ? '/signup' : waitlistHeroHref}
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
                  padding: '14px 24px',
                  fontSize: 15,
                  fontWeight: 600,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {deployEnabled ? 'Deploy your own' : 'Join waitlist'}
              </Link>
            </div>

            {/* Hero meta strip (v23) — three-fact mono row under CTAs.
                Live dot before "3 live apps" cues credibility without
                pulling focus from the H1. */}
            <div
              data-testid="hero-meta-strip"
              style={{
                marginTop: 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 14,
                flexWrap: 'wrap',
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 11.5,
                color: 'var(--muted)',
                letterSpacing: '0.02em',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: 'var(--accent)',
                    boxShadow: '0 0 0 3px rgba(4, 120, 87, 0.18)',
                  }}
                />
                3 live apps
              </span>
              <span aria-hidden="true">&middot;</span>
              <span>MIT-licensed core</span>
              <span aria-hidden="true">&middot;</span>
              <span>Self-host in 1 command</span>
            </div>
          </div>

          {/* Hero demo — interactive 3-state build/deploy/use loop.
              Sits directly under the CTAs. Sized to 580px (Cursor-style,
              Federico 2026-04-23): top ~120-150px is visible above the fold
              at 1440x900, rest scrolls into view. Bigger canvas = more
              cinematic, no squishing to fit the viewport. */}
          <HeroDemo />
        </section>

        {/* Compact CLI reference strip below the hero — smaller than the
            original hero-inline version (Federico 2026-04-23 — moved out of
            hero, kept below as a smaller block). */}
        <section
          data-testid="cli-reference-section"
          style={{ padding: '32px 24px 8px' }}
        >
          <CliReference />
        </section>

        {/* SHOWCASE — v23 editorial 1-hero + 2-compact grid with neutral
            run-result banner thumbs (Federico-locked: NO category tints).
            Replaces the prior <AppStripe variant="landing"/> × 3 pattern. */}
        <ShowcaseGridV23 stripes={stripes} />

        {/* HOW IT WORKS — v23 styled band: warm studio bg + top/bottom
            borders + 3-node numbered timeline above the cards (Delta 11.1).
            Full-bleed background; inner content stays at the 1180 grid. */}
        <section
          data-testid="how-it-works"
          style={{
            background: 'var(--studio, #f5f4f0)',
            borderTop: '1px solid var(--line)',
            borderBottom: '1px solid var(--line)',
            padding: '64px 28px',
          }}
        >
          <div style={{ maxWidth: 1180, margin: '0 auto' }}>
            <div style={{ textAlign: 'center' }}>
              <SectionEyebrow>How it works</SectionEyebrow>
            </div>
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 32,
                lineHeight: 1.1,
                letterSpacing: '-0.025em',
                textAlign: 'center',
                margin: '0 auto 20px',
                maxWidth: 560,
              }}
            >
              From idea to shipped app in 3 steps.
            </h2>

            {/* 3-node timeline above cards (v23 Delta 11.1) */}
            <div
              className="step-timeline"
              data-testid="how-it-works-timeline"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 0,
                maxWidth: 520,
                margin: '0 auto 28px',
                padding: '8px 0',
              }}
            >
              {[1, 2, 3].map((n, idx) => (
                <Fragment key={n}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 34,
                      height: 34,
                      borderRadius: 999,
                      background: 'var(--accent-soft, #ecfdf5)',
                      border: '1.5px solid var(--accent-border, #d1fae5)',
                      color: 'var(--accent)',
                      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                      fontWeight: 700,
                      fontSize: 13,
                      flexShrink: 0,
                    }}
                  >
                    {n}
                  </span>
                  {idx < 2 && (
                    <span
                      aria-hidden="true"
                      style={{
                        flex: 1,
                        height: 2,
                        background: 'var(--line)',
                        margin: '0 6px',
                      }}
                    />
                  )}
                </Fragment>
              ))}
            </div>

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
          </div>
        </section>

        {/* WORKED EXAMPLE — one concrete run (#541, Federico 2026-04-23).
            Dedicated mid-page band that shows the Lead Scorer output in
            full (87/100 "Strong fit" on stripe.com). Separate from the
            HeroDemo USE tab so a scroller who skipped the demo still
            lands on a complete example before they leave. */}
        <WorkedExample />

        {/* THREE SURFACES DIAGRAM — non-tech visual (#542). Inline SVG,
            "paste app -> web page + MCP + API". Scales cleanly, single
            brand accent for connectors, no bespoke PNG. */}
        <ThreeSurfacesDiagram />

        {/* FIT BAND — who it's for / who it's not for (#543). Honest
            about the shape before the visitor signs up. */}
        <FitBand />

        {/* PUBLISH-CTA BOX — v23 anchor target for `#waitlist` topbar/footer
            links. Section id stays attached to the wrapper so the section
            jumps land at the correct scroll offset under sticky chrome. */}
        <section id="waitlist" style={{ padding: '24px 28px', maxWidth: 1240, margin: '0 auto' }}>
          <PublishCtaBox />
        </section>

        {/* DUAL AUDIENCES — makers + teams */}
        <DualAudiences />

        {/* PRICING TEASER — single $0 card */}
        <PricingTeaser />

        {/* BUILD CTA */}
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
        {/* WHO'S BEHIND IT — single-founder context + direct contact
            (#589, Federico 2026-04-23). Sits near the bottom so a
            visitor has already seen the product by the time they ask
            "who's building this?". Photo is served from
            /team/fede.jpg — a placeholder ships in the repo for
            day-one parity; Federico overwrites the file locally when
            he has a photo he likes. */}
        <WhosBehind />

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
    mono: 'floom.dev/p/your-app',
  },
];
