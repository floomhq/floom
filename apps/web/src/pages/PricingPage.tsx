// /pricing — v17 cleanup 2026-04-23.
//
// Previous revision nested 3 limit cards + a 5-column spec strip inside a
// single hero card ("this looks messy", Fede 2026-04-23). This rewrite
// collapses the hero into one clean $0 card with three stacked pricing rows
// and a single inline spec line. One primary CTA + one secondary text link.
// Self-host + later-plans + FAQ kept, already clean.
// Palette: bg #fafaf8, ink #0e0e0c, accent #047857.

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { readDeployEnabled } from '../lib/flags';
import { waitlistHref } from '../lib/waitlistCta';

// ---------------------------------------------------------------------------
// Palette tokens (inline — matches v17 wireframe variables)
// ---------------------------------------------------------------------------
const INK = '#0e0e0c';
const MUTED = '#6b7280';
const ACCENT = '#047857';
const CARD_BG = '#ffffff';
const STUDIO_BG = '#f3f4f2';
const LINE = '#e5e7eb';
const LINE_HOVER = '#d1d5db';

// ---------------------------------------------------------------------------
// Typography helpers
// ---------------------------------------------------------------------------
const MONO: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
};

// Display (formerly SERIF — pre-2026-04-24 the display family was
// DM Serif Display; swapped to Inter 800 tight-tracked, see the
// --font-display token in wireframe.css). Keeping the exported name
// to avoid churning the ~40 call sites in this file for a cosmetic
// rename.
const SERIF: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  letterSpacing: '-0.025em',
};

const EYEBROW: React.CSSProperties = {
  ...MONO,
  fontSize: 11,
  fontWeight: 700,
  color: ACCENT,
  textTransform: 'uppercase',
  letterSpacing: '0.10em',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 12,
};

// ---------------------------------------------------------------------------
// Pricing rows — three stacked options (vertical list, not nested boxes).
// Cleanup 2026-04-23: the old 3-column nested-card grid read as visual bloat.
// ---------------------------------------------------------------------------
const LIMITS = [
  {
    k: "On Floom's key",
    v: '5 runs / app / 24h',
    s: (
      <>
        Per anonymous IP or signed-in account. 10 runs / hour on public
        permalink. 1 concurrent run.
      </>
    ),
  },
  {
    k: 'With your own key',
    v: 'Unlimited runs',
    s: (
      <>
        Paste a Gemini, OpenAI, or Anthropic key in /me &rarr; Secrets.
        Encrypted, never returned. 3 concurrent runs.
      </>
    ),
  },
  {
    k: 'Self-host',
    v: 'Unlimited, free forever',
    s: (
      <>
        One Docker command. Open source. Unlimited concurrency. See{' '}
        <a
          href="https://github.com/floomhq/floom"
          style={{ color: ACCENT, fontWeight: 600 }}
        >
          self-host guide
        </a>
        .
      </>
    ),
  },
];

// Inline runtime-specs note (replaces the old 5-column spec strip).
const SPECS_INLINE = '512 MB RAM \u00b7 1 vCPU \u00b7 5 min timeout \u00b7 10 MB max input/upload';

// ---------------------------------------------------------------------------
// FAQ data (6 questions from v17 wireframe — verbatim)
// ---------------------------------------------------------------------------
interface FaqItem {
  q: string;
  a: React.ReactNode;
}

const FAQS: FaqItem[] = [
  {
    q: 'What happens when I hit 5 runs/app/day?',
    a: 'You see a modal asking for your Gemini API key. Paste it once and runs use your key from then on, unlimited. Your key is stored encrypted in Floom and never returned by the API.',
  },
  {
    q: 'Can I self-host Floom?',
    a: (
      <>
        Yes, and it&rsquo;s fully free. The core runtime is open source. Run{' '}
        <code
          style={{
            ...MONO,
            fontSize: 12,
            color: INK,
            background: STUDIO_BG,
            border: `1px solid ${LINE}`,
            borderRadius: 6,
            padding: '2px 7px',
          }}
        >
          docker run -p 3000:3000 ghcr.io/floomhq/floom-monorepo:latest
        </code>{' '}
        on your own infra and you&rsquo;re live in under a minute. See the{' '}
        <a
          href="https://github.com/floomhq/floom"
          style={{ color: ACCENT, fontWeight: 600 }}
        >
          self-host guide
        </a>{' '}
        for volumes and env vars.
      </>
    ),
  },
  {
    q: 'Why no paid plan yet?',
    a: (
      <>
        Launch week is about usage signal, not revenue. We&rsquo;ll price Pro
        and Team once we see where real workloads need more than BYOK. If you
        want to be on the list for paid features early,{' '}
        <a
          href="mailto:team@floom.dev"
          style={{ color: ACCENT, fontWeight: 600 }}
        >
          email us
        </a>
        .
      </>
    ),
  },
  {
    q: 'Is there a run timeout?',
    a: (
      <>
        Yes. A single app run is capped at 5 minutes on the hosted runtime.
        Self-host is configurable via{' '}
        <code
          style={{
            ...MONO,
            fontSize: 12,
            color: INK,
            background: STUDIO_BG,
            border: `1px solid ${LINE}`,
            borderRadius: 6,
            padding: '2px 7px',
          }}
        >
          RUNNER_TIMEOUT
        </code>
        .
      </>
    ),
  },
  {
    q: 'Do you take a cut of revenue my app makes?',
    a: "No. Floom is the platform. If your app charges end users (it doesn't have to), that's yours. We don't see it, touch it, or take a percentage.",
  },
];

function ownershipFaq(deployEnabled: boolean): FaqItem {
  if (deployEnabled) {
    return {
      q: 'Who owns the apps I publish?',
      a: "You do. Apps stay under your account, exportable any time. Floom doesn't claim rights to your code or your runs.",
    };
  }
  return {
    q: 'Who owns the apps I publish?',
    a: (
      <>
        You do. Apps stay under your account, exportable any time. Floom
        doesn&apos;t claim rights to your code or your runs. Publishing new apps
        to the floom.dev cloud is waitlist-only during launch; self-host has no
        such gate.
      </>
    ),
  };
}

// ---------------------------------------------------------------------------
// FaqEntry — collapsible row
// ---------------------------------------------------------------------------
function FaqEntry({ q, a }: FaqItem) {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        background: CARD_BG,
        border: `1px solid ${LINE}`,
        borderRadius: 12,
        padding: '18px 22px',
        marginBottom: 10,
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          all: 'unset',
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          fontSize: 14.5,
          fontWeight: 600,
          color: INK,
          lineHeight: 1.4,
        }}
        aria-expanded={open}
      >
        <span>{q}</span>
        <span
          style={{
            ...MONO,
            fontSize: 18,
            fontWeight: 400,
            color: MUTED,
            flexShrink: 0,
            marginLeft: 16,
          }}
          aria-hidden="true"
        >
          {open ? '\u2212' : '+'}
        </span>
      </button>
      {open && (
        <p
          style={{
            fontSize: 13.5,
            color: MUTED,
            lineHeight: 1.6,
            margin: '12px 0 0',
          }}
        >
          {a}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function PricingPage() {
  const deployEnabled = useMemo(() => readDeployEnabled(), []);
  const faqs = useMemo(
    () => [...FAQS, ownershipFaq(deployEnabled)],
    [deployEnabled],
  );

  return (
    <PageShell
      title="Pricing · Floom"
      description="Floom Cloud is free during the launch waitlist. Self-hosting is always free and open source. Paid tiers with per-app metering, team features, and SLAs are on the roadmap."
      contentStyle={{
        padding: '0 0 80px',
        maxWidth: '100%',
        background: '#fafaf8',
      }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* HERO                                                                 */}
      {/* ------------------------------------------------------------------ */}
      <section
        data-testid="pricing-hero"
        style={{
          padding: '56px 28px 12px',
          textAlign: 'center',
          maxWidth: 820,
          margin: '0 auto',
        }}
      >
        <div style={EYEBROW}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: ACCENT,
              boxShadow: `0 0 0 3px rgba(4,120,87,0.15)`,
              flexShrink: 0,
            }}
          />
          Launch week &middot; 27 April 2026
        </div>
        <h1
          style={{
            ...SERIF,
            fontSize: 52,
            lineHeight: 1.05,
            letterSpacing: '-0.025em',
            color: INK,
            margin: '0 0 14px',
          }}
        >
          Free.{' '}
          <span style={{ color: ACCENT }}>Your own key → unlimited.</span>
        </h1>
        <p
          style={{
            fontSize: 17,
            color: MUTED,
            margin: '0 auto',
            lineHeight: 1.55,
            maxWidth: 620,
          }}
        >
          {deployEnabled ? (
            <>
              Every app on Floom runs on our Gemini key, no credit card.
              Paid tiers come after launch.
            </>
          ) : (
            <>
              Runs on floom.dev stay on our Gemini key, no credit card.
              Publishing new apps is waitlist-only; self-host has no gate.
              Paid tiers come after launch.
            </>
          )}
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* FREE CARD                                                            */}
      {/* ------------------------------------------------------------------ */}
      <section
        data-testid="pricing-free-card"
        style={{ maxWidth: 720, margin: '36px auto 48px', padding: '0 24px' }}
      >
        <div
          style={{
            background: CARD_BG,
            border: `1px solid ${LINE}`,
            borderRadius: 18,
            padding: '36px 36px 30px',
            textAlign: 'center',
            boxShadow: '0 20px 60px -40px rgba(14,14,12,0.14)',
          }}
        >
          {/* Price */}
          <div
            style={{
              ...SERIF,
              fontSize: 72,
              lineHeight: 1,
              letterSpacing: '-0.03em',
              color: INK,
              margin: '6px 0 8px',
            }}
          >
            $0
          </div>
          <p
            style={{
              fontSize: 14,
              color: MUTED,
              margin: '0 0 18px',
            }}
          >
            for everyone, until paid tiers land
          </p>
          <p
            style={{
              fontSize: 15.5,
              color: INK,
              lineHeight: 1.6,
              margin: '0 auto 22px',
              maxWidth: 560,
            }}
          >
            {deployEnabled ? (
              <>
                Run any of the live apps. Publish your own. No credit card, no
                trial timer.
              </>
            ) : (
              <>
                Run any of the live apps on floom.dev. Publishing your own app to
                our cloud is waitlist-only; self-host is unrestricted. No credit
                card, no trial timer.
              </>
            )}
          </p>

          {/* Pricing rows — stacked list, not nested cards. Simpler hierarchy. */}
          <div
            data-testid="pricing-rows"
            style={{
              display: 'flex',
              flexDirection: 'column',
              margin: '20px 0 8px',
              textAlign: 'left',
              borderTop: `1px solid ${LINE}`,
            }}
          >
            {LIMITS.map((cell) => (
              <div
                key={cell.k}
                data-testid={`pricing-row-${cell.k.toLowerCase().replace(/[^a-z]+/g, '-')}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: 16,
                  alignItems: 'baseline',
                  padding: '18px 4px',
                  borderBottom: `1px solid ${LINE}`,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 14.5,
                      fontWeight: 600,
                      color: INK,
                      lineHeight: 1.3,
                      marginBottom: 4,
                    }}
                  >
                    {cell.k}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: MUTED,
                      lineHeight: 1.55,
                    }}
                  >
                    {cell.s}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: INK,
                    whiteSpace: 'nowrap',
                    ...MONO,
                  }}
                >
                  {cell.v}
                </div>
              </div>
            ))}
          </div>

          {/* Inline spec note — replaces the old 5-column strip. */}
          <p
            data-testid="pricing-specs-inline"
            style={{
              ...MONO,
              fontSize: 11.5,
              color: MUTED,
              margin: '16px 0 22px',
              letterSpacing: '0.02em',
              textAlign: 'center',
            }}
          >
            {SPECS_INLINE}
          </p>

          {/* CTA — one primary button + one text link. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 20,
              marginTop: 8,
              flexWrap: 'wrap',
            }}
          >
            {/* Primary CTA gated on deployEnabled: in waitlist mode, /signup
                redirects to /waitlist, so the button should read as a waitlist
                ask up front rather than bait-and-switch. */}
            <Link
              to={deployEnabled ? '/signup' : waitlistHref('pricing-hero')}
              data-testid="pricing-cta-signup"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '12px 24px',
                borderRadius: 999,
                fontSize: 15,
                fontWeight: 600,
                textDecoration: 'none',
                background: ACCENT,
                color: '#fff',
                border: `1px solid ${ACCENT}`,
              }}
            >
              {deployEnabled ? 'Create your account' : 'Join the waitlist'}
            </Link>
            <Link
              to="/docs"
              data-testid="pricing-cta-docs"
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: INK,
                textDecoration: 'none',
                borderBottom: `1px solid ${LINE_HOVER}`,
                paddingBottom: 2,
              }}
            >
              Read the docs &rarr;
            </Link>
          </div>

          {/* Fine print */}
          <p
            style={{
              ...MONO,
              fontSize: 12,
              color: MUTED,
              marginTop: 18,
              letterSpacing: '0.03em',
            }}
          >
            no credit card &middot; no trial &middot; no paywall
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* SELF-HOST STRIP                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section
        data-testid="pricing-selfhost"
        style={{ maxWidth: 820, margin: '0 auto 48px', padding: '0 24px' }}
      >
        <div
          className="selfhost-inner"
          style={{
            background: CARD_BG,
            border: `1px solid ${LINE}`,
            borderRadius: 14,
            padding: '24px 28px',
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 20,
            alignItems: 'center',
          }}
        >
          <div>
            <h3
              style={{
                ...SERIF,
                fontSize: 22,
                lineHeight: 1.2,
                color: INK,
                margin: '0 0 6px',
                letterSpacing: '-0.02em',
              }}
            >
              Prefer to run it yourself?
            </h3>
            <p
              style={{
                fontSize: 13.5,
                color: MUTED,
                lineHeight: 1.55,
                margin: 0,
                maxWidth: 500,
              }}
            >
              The core runtime is open source. One command, one container,
              your infra. See{' '}
              <a
                href="https://github.com/floomhq/floom"
                style={{ color: ACCENT, fontWeight: 600 }}
              >
                Self-host guide
              </a>
              .
            </p>
          </div>
          <code
            style={{
              ...MONO,
              fontSize: 12,
              color: INK,
              background: STUDIO_BG,
              border: `1px solid ${LINE}`,
              borderRadius: 6,
              padding: '6px 12px',
              whiteSpace: 'nowrap',
            }}
          >
            docker run -p 3000:3000 ghcr.io/floomhq/floom-monorepo:latest
          </code>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* LATER-PLANS LINE                                                     */}
      {/* ------------------------------------------------------------------ */}
      <section
        data-testid="pricing-later-plans"
        style={{ maxWidth: 820, margin: '0 auto 56px', padding: '0 24px' }}
      >
        <div
          style={{
            background: STUDIO_BG,
            border: `1px dashed ${LINE_HOVER}`,
            borderRadius: 14,
            padding: '22px 28px',
            textAlign: 'center',
          }}
        >
          <p
            style={{
              fontSize: 14,
              color: INK,
              lineHeight: 1.6,
              margin: 0,
              fontWeight: 500,
            }}
          >
            Paid plans coming post-launch.{' '}
            <span style={{ color: MUTED, fontWeight: 400 }}>
              Free forever for self-host.
            </span>
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* FAQ                                                                  */}
      {/* ------------------------------------------------------------------ */}
      <section
        data-testid="pricing-faq"
        style={{
          maxWidth: 780,
          margin: '0 auto 56px',
          padding: '0 28px',
        }}
      >
        <h2
          style={{
            ...SERIF,
            fontSize: 28,
            textAlign: 'center',
            letterSpacing: '-0.02em',
            color: INK,
            margin: '0 0 24px',
          }}
        >
          Questions, answered.
        </h2>
        {faqs.map((faq) => (
          <FaqEntry key={faq.q} q={faq.q} a={faq.a} />
        ))}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Responsive overrides                                                 */}
      {/* ------------------------------------------------------------------ */}
      <style>{`
        @media (max-width: 700px) {
          .selfhost-inner {
            grid-template-columns: 1fr !important;
          }
        }
        @media (max-width: 640px) {
          /* Mobile polish: serif headlines are oversized at 52/72px on a
             375px viewport. Scale them down so the hero + free-card fit
             above the fold without wrapping awkwardly. */
          [data-testid="pricing-hero"] { padding: 36px 20px 8px !important; }
          [data-testid="pricing-hero"] h1 { font-size: 34px !important; line-height: 1.08 !important; }
          [data-testid="pricing-hero"] p { font-size: 15px !important; }
          [data-testid="pricing-free-card"] { padding: 0 16px !important; margin: 24px auto 36px !important; }
          [data-testid="pricing-free-card"] > div { padding: 28px 20px 24px !important; }
          [data-testid="pricing-free-card"] > div > div:first-of-type { font-size: 56px !important; }
        }
      `}</style>
    </PageShell>
  );
}
