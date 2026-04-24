/**
 * LandingV17Page — marketing home `/` rebuilt to the v17 wireframes.
 *
 * 2026-04-24 restructure ("landing still feels messy"):
 *   Federico audit flagged the landing as too tall, too duplicated, and
 *   with a missing manifesto band on preview. This revision collapses the
 *   page to 7 core sections (was 9):
 *     1. Hero (slim: H1 + sub + CTAs only, no inline DeployYourOwnTile)
 *     2. ManifestoBand (the vision) — "Infrastructure for agentic work."
 *     3. TryTheseApps (3 live apps)
 *     4. SelfHost band
 *     5. CliReference + HowItWorks (3 steps)
 *     6. DualAudiences (makers + teams)
 *     7. PricingTeaser + Final CTA + Footer
 *   Removed: the duplicate Showcase stripes (same 3 apps as TryTheseApps),
 *   the PublishCtaBox (duplicated DualAudiences' makers column), and the
 *   inline DeployYourOwnTile (hero bloat — the hero-secondary CTA and the
 *   SelfHost band already carry that message).
 *   The works-with-MCP eyebrow moved from above-H1 to a thin proof-bar
 *   BELOW the hero CTAs — the H1 now leads, the compatibility claim trails.
 *
 * 2026-04-27 waitlist-reality rewrite (still applies):
 *   floom.dev (production) is waitlist-only for the build/deploy flow, but
 *   the 3 featured apps (Lead Scorer, Resume Screener, Competitor Analyzer)
 *   are live and runnable today. preview.floom.dev keeps the full flow.
 *     - Hero CTAs: [Try an app] primary, [Join the waitlist] secondary.
 *     - Hero demo: full 3-state build -> deploy -> use (visual explainer).
 *     - Every deploy/publish CTA across the page reacts to DEPLOY_ENABLED.
 *
 * Sources of truth:
 *   /var/www/wireframes-floom/v17/landing.html            (desktop)
 *   /var/www/wireframes-floom/v17/landing-mobile.html     (mobile)
 *   /var/www/wireframes-floom/v17/REVISION-2026-04-22.md  (latest revisions)
 *   /root/floom-internal/launch/v17-preview-delta-2026-04-22.md
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

import { TopBar } from '../components/TopBar';
import { PublicFooter } from '../components/public/PublicFooter';
import { FeedbackButton } from '../components/FeedbackButton';

import { PageHead } from '../components/PageHead';
import { WorksWithBelt } from '../components/home/WorksWithBelt';
import { CliReference } from '../components/home/CliReference';
import { DualAudiences } from '../components/home/DualAudiences';
import { PricingTeaser } from '../components/home/PricingTeaser';
import { HeroDemo } from '../components/home/HeroDemo';
import { SectionEyebrow } from '../components/home/SectionEyebrow';
import { TryTheseApps } from '../components/home/TryTheseApps';
import { ManifestoBand } from '../components/landing/ManifestoBand';
import { SelfHostSection } from '../components/home/SelfHostSection';

import { DEPLOY_ENABLED, useDeployEnabled } from '../lib/flags';
import { WaitlistModal } from '../components/WaitlistModal';

export function LandingV17Page() {
  // Launch feature flag (2026-04-27). When false, the secondary
  // "Deploy your own" hero link swaps to a "Join waitlist" button that
  // opens WaitlistModal instead of navigating to /signup.
  const deployEnabled = useDeployEnabled();
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  return (
    <div
      className="page-root landing-v17"
      data-testid="landing-v17"
      style={{ minHeight: '100vh', background: 'var(--bg)' }}
    >
      <PageHead
        title="Ship AI apps fast · Floom"
        description="Floom is the protocol and runtime for agentic work. Paste your app's link and get a Claude tool, a page to share, a command-line, and a clean URL your teammates can hit."
      />
      <TopBar />

      <main id="main" style={{ display: 'block' }}>
        {/* HERO — wireframe: .hero-shell > .hero
            Cursor-style layout. Demo does NOT have to fit the viewport in
            full — people scroll. The hero reads as: nav / breath / H1 /
            sub / CTAs / proof belt / demo (demo naturally tall).
            2026-04-24 (Federico feedback): the H1 was sitting almost flush
            against the top nav with ~16px of breathing room, which made
            the headline feel cramped. Top padding bumped to 96px desktop
            (overridden to 56px at ≤640px) so the H1 has real breathing
            room above it. Bottom stays modest — the gradient already
            hands off to the manifesto band below. */}
        <section
          data-testid="hero"
          style={{
            position: 'relative',
            // Breathing room above the H1 — Federico 2026-04-24. Mobile
            // override in the scoped <style> block below drops this to
            // 56px so the small-screen hero doesn't start with a huge
            // empty block.
            padding: '96px 24px 32px',
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
            {/* H1 — "Ship AI apps fast." (Federico 2026-04-24 —
                restored the original punchy two-word-verb headline that
                preview used to carry. The 2026-04-27 waitlist-reality
                rewrite "AI apps you can ship as easily as you write a
                prompt." softened the verb to account for a gated Deploy,
                but on the actual page that full sentence read unclear
                — too many clauses, "ship" fighting "write a prompt" for
                the sentence's centre of gravity. We'd rather keep the
                hero short and let the subtitle carry the nuance; that's
                also how Cursor/Linear/Vercel structure their own launch
                heroes. Waitlist gating is communicated unambiguously by
                the CTA row below (primary "Try an app", secondary
                "Join the waitlist to build your own") and by the
                publish-waitlist banner on /docs and /apps. Font swap at
                the same time: DM Serif Display out, Inter 800 with
                tight tracking in — see wireframe.css rationale on
                --font-display. */}
            {/* Accent on "fast." lifted from the v17 landing wireframe
                (v17-wireframes/v17/landing.html line 146). Giving the
                punch word the green accent color sharpens the hero
                without adding any new element — the headline's rhythm
                is intact, but the eye now lands on the promise word,
                not the mass of "Ship AI apps". Federico 2026-04-25
                "hero could still be cleaner" — this is the single
                highest-leverage visual pop on the page that doesn't
                require layout surgery. */}
            <h1
              className="hero-headline"
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 72,
                lineHeight: 1.0,
                letterSpacing: '-0.04em',
                color: 'var(--ink)',
                margin: '0 0 16px',
                textWrap: 'balance' as unknown as 'balance',
              }}
            >
              Ship AI apps <span style={{ color: 'var(--accent)' }}>fast.</span>
            </h1>

            {/* Subtitle. Single line. The old hero carried a second
                "For founders, solo devs, and small teams" line underneath
                this one; Federico 2026-04-24 asked to drop it — one
                subtitle is enough, and the protocol-runtime framing
                covers the intended audience implicitly. 2026-04-25 —
                tightened margin-bottom (32 -> 24) so the CTAs don't
                float far below the sub; same intent as the H1 margin
                trim above. */}
            <p
              className="hero-sub"
              data-testid="hero-sub-positioning"
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 20,
                lineHeight: 1.45,
                fontWeight: 400,
                color: 'var(--muted)',
                maxWidth: 640,
                margin: '0 auto 24px',
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

            {/* Works-with proof strip — moved BELOW the CTAs (2026-04-24
                restructure). Previously sat above the H1 as a compat
                eyebrow, but pushed the headline down and competed with the
                H1 for attention. Below the CTAs it reads as quiet proof
                ("this works with your tools"), not a lede. */}
            <div style={{ marginTop: 20 }}>
              <WorksWithBelt />
            </div>
          </div>

          {/* Hero demo — morphing canvas. Full build -> deploy -> use loop.
              The hero demo is a visual explainer of the product shape,
              unrelated to DEPLOY_ENABLED (which gates the *public*
              deploy flow at the CTA layer). The Use state shows Lead
              Scorer returning a real fit score. */}
          <HeroDemo />
        </section>

        {/* MANIFESTO BAND — vision-forward block under the hero.
            Federico 2026-04-24: "we need to say clearly we are building
            infra for agentic work. more big vision talk, rn it feels like
            a tool". Direction A, Option 2 (hybrid): the benefit-forward
            hero ("Ship AI apps fast.") stays as the wedge, this band adds
            the philosophy ("Infrastructure for agentic work."). Placed
            between hero and TryTheseApps so the page reads: promise -> why
            we exist -> proof. */}
        <ManifestoBand />

        {/* "Try these 3 apps" — 3 side-by-side cards of the live featured
            apps. Placed strategically just below the hero, BEFORE the "how
            it works" narrative, so the page delivers a usable product (not
            a promise) in the first scroll. 2026-04-27 launch-strategy pivot. */}
        <TryTheseApps />

        {/* SELF-HOST — dedicated band. Federico 2026-04-24: "make self-
            hosting prominent". Commercial evaluators landing on floom.dev
            should see within one scroll that waiting for the beta is
            optional: the OSS image is shipped today, one docker run away.
            Keeps the launch page honest about what's available without
            hiding the hosted story. */}
        <SelfHostSection />

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
          style={{ padding: '56px 28px', maxWidth: 1240, margin: '0 auto' }}
        >
          <SectionEyebrow>How it works</SectionEyebrow>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 34,
              lineHeight: 1.1,
              letterSpacing: '-0.03em',
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

        {/* 2026-04-24 restructure: two duplicated sections removed here.
            - <Showcase /> — same 3 apps as <TryTheseApps /> above; pure
              duplication. Was previously gated on DEPLOY_ENABLED so it
              only hit preview, but even on preview it was redundant. */}

        {/* 2026-04-24 restructure: <PublishCtaBox /> also removed — its
            "Publish your own app" tile duplicated the Makers column of
            <DualAudiences /> below. One "for makers" CTA per page is
            enough; DualAudiences carries it alongside the teams column. */}

        {/* DUAL AUDIENCES — makers + teams */}
        <DualAudiences />

        {/* PRICING TEASER — single $0 card */}
        <PricingTeaser />

        {/* FINAL CTA — docs + GitHub stay put (informational CTAs, not
            deploy promises). Where there was previously an implicit "deploy
            your first app" framing, the copy now leans on "join the waitlist"
            on prod. Reverts when DEPLOY_ENABLED is on. */}
        <section
          data-testid="final-cta"
          style={{
            padding: '56px 28px',
            maxWidth: 760,
            margin: '0 auto',
            textAlign: 'center',
          }}
        >
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 26,
              lineHeight: 1.1,
              letterSpacing: '-0.025em',
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
          .landing-v17 [data-testid="hero"] { padding: 56px 16px 32px !important; }
          .landing-v17 .hero-headline { font-size: 34px !important; line-height: 1.06 !important; }
          .landing-v17 .hero-sub { font-size: 15px !important; margin-bottom: 20px !important; }
          .landing-v17 .hero-ctas { flex-direction: column !important; align-items: stretch !important; gap: 8px !important; }
          .landing-v17 .hero-ctas a, .landing-v17 .hero-ctas button { width: 100% !important; }
          .landing-v17 .hero-ctas a[data-testid="hero-cta-try-app"] { padding: 14px 20px !important; min-height: 44px !important; box-sizing: border-box !important; }
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
          .landing-v17 [data-testid="hero"] { padding-top: 56px !important; padding-bottom: 32px !important; }
          .landing-v17 [data-testid="cli-reference-section"] { padding-top: 24px !important; padding-bottom: 8px !important; }
          /* Display H2 across the page: scale down so long headlines
             don't overflow on narrow screens. 34->26, 28->24. */
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

// 2026-04-24 restructure: DeployYourOwnTile removed. The tile sat directly
// under the HeroDemo, pushing the hero to ~1100px and visually competing
// with (a) the hero CTA row above it and (b) the SelfHost band below the
// manifesto. The hero secondary CTA ("Join the waitlist to build your own")
// already carries the waitlist ask, and the SelfHost band carries the
// self-host ask — this tile was redundant on both axes.

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
