// /pricing — v17 rewrite 2026-04-22.
//
// Single $0 card + 3 limit cells + spec strip + 6-question FAQ.
// No 3-tier grid. No "Cloud Pro TBD". No "Sign in free".
// CTA: "Create your account". Palette: bg #fafaf8, ink #0e0e0c, accent #047857.

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';

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

const SERIF: React.CSSProperties = {
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontWeight: 400,
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
// Spec strip data
// ---------------------------------------------------------------------------
const SPECS = [
  { k: 'Memory', v: '512 MB' },
  { k: 'CPU', v: '1 vCPU' },
  { k: 'Run timeout', v: '5 min' },
  { k: 'Max input', v: '10 MB' },
  { k: 'Max upload', v: '10 MB' },
];

// ---------------------------------------------------------------------------
// Limit cells data
// ---------------------------------------------------------------------------
const LIMITS = [
  {
    k: "On Floom's key",
    v: '5 runs / app / 24h',
    s: (
      <>
        Per anonymous IP or signed-in account. 10 runs / hour on public
        permalink.{' '}
        <strong style={{ color: INK, fontWeight: 600 }}>
          1 concurrent run.
        </strong>
      </>
    ),
  },
  {
    k: 'With your own key',
    v: 'Unlimited runs',
    s: (
      <>
        Paste a Gemini, OpenAI, or Anthropic key in /me &rarr; Secrets.
        Encrypted, never returned.{' '}
        <strong style={{ color: INK, fontWeight: 600 }}>
          3 concurrent runs.
        </strong>
      </>
    ),
  },
  {
    k: 'Self-host',
    v: 'Unlimited, free forever',
    s: (
      <>
        One Docker command. MIT-licensed.{' '}
        <strong style={{ color: INK, fontWeight: 600 }}>
          Unlimited concurrency.
        </strong>{' '}
        See{' '}
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
        Yes, and it&rsquo;s fully free. The core runtime is MIT-licensed. Run{' '}
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
          docker run floomhq/floom-docker
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
  {
    q: 'Who owns the apps I publish?',
    a: "You do. Apps stay under your account, exportable any time. Floom doesn't claim rights to your code or your runs.",
  },
];

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
  return (
    <PageShell
      title="Pricing · Floom"
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
          <span style={{ color: ACCENT }}>Rate-limited, not paywalled.</span>
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
          Every app on Floom runs for free on our Gemini key. When you hit the
          limit, paste your own key for unlimited. Paid tiers come after launch.
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
            Run any of the 22 live apps. Publish your own. No credit card, no
            trial timer.
          </p>

          {/* Limit cells */}
          <div
            className="limits-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 10,
              margin: '22px 0',
              textAlign: 'left',
            }}
          >
            {LIMITS.map((cell) => (
              <div
                key={cell.k}
                style={{
                  background: STUDIO_BG,
                  border: `1px solid ${LINE}`,
                  borderRadius: 12,
                  padding: '16px',
                }}
              >
                <div
                  style={{
                    ...MONO,
                    fontSize: 10,
                    color: MUTED,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    marginBottom: 6,
                  }}
                >
                  {cell.k}
                </div>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    color: INK,
                    lineHeight: 1.25,
                    marginBottom: 4,
                  }}
                >
                  {cell.v}
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: MUTED,
                    lineHeight: 1.5,
                  }}
                >
                  {cell.s}
                </div>
              </div>
            ))}
          </div>

          {/* Spec strip */}
          <div
            className="spec-strip"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: 8,
              margin: '8px 0 22px',
              textAlign: 'left',
            }}
          >
            {SPECS.map((spec) => (
              <div
                key={spec.k}
                style={{
                  background: STUDIO_BG,
                  border: `1px solid ${LINE}`,
                  borderRadius: 10,
                  padding: '10px 12px',
                }}
              >
                <div
                  style={{
                    ...MONO,
                    fontSize: 9.5,
                    color: MUTED,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    marginBottom: 3,
                  }}
                >
                  {spec.k}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: INK,
                  }}
                >
                  {spec.v}
                </div>
              </div>
            ))}
          </div>

          {/* CTAs */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 10,
              marginTop: 6,
              flexWrap: 'wrap',
            }}
          >
            <Link
              to="/login"
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
              Create your account
            </Link>
            <Link
              to="/docs"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '12px 24px',
                borderRadius: 999,
                fontSize: 15,
                fontWeight: 600,
                textDecoration: 'none',
                background: 'transparent',
                color: INK,
                border: `1px solid ${LINE_HOVER}`,
              }}
            >
              Read the docs
            </Link>
          </div>

          {/* Fine print */}
          <p
            style={{
              ...MONO,
              fontSize: 12,
              color: MUTED,
              marginTop: 14,
              letterSpacing: '0.03em',
            }}
          >
            no credit card &middot; no trial &middot; no paywall &middot; runs
            logged in /me
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
              The core runtime is MIT-licensed. One command, one container,
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
            docker run -p 3000:3000 floomhq/floom-docker
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
        {FAQS.map((faq) => (
          <FaqEntry key={faq.q} q={faq.q} a={faq.a} />
        ))}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Responsive overrides                                                 */}
      {/* ------------------------------------------------------------------ */}
      <style>{`
        @media (max-width: 700px) {
          .limits-grid {
            grid-template-columns: 1fr !important;
          }
          .spec-strip {
            grid-template-columns: repeat(2, 1fr) !important;
          }
          .selfhost-inner {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </PageShell>
  );
}
