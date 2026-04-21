// /pricing — honest placeholder for commercial visitors.
//
// 2026-04-20 (pd-12 follow-up, product audit): Previously `/pricing`
// redirected to `/`, which was a conversion dead-end for anyone who
// arrived from HN / outbound / comparison sites hunting for cost info.
// Floom is pre-1.0 with Stripe Connect deferred (see
// docs/DEFERRED-UI.md §3), so there are no real plans to list. This
// page says that plainly instead of hiding it.
//
// Design rules applied (from ~/.claude/skills/product/SKILL.md):
//   - Earn trust, don't claim it: no fake anchors, no "contact sales"
//     theatre, no countdown timers.
//   - State limitations plainly: "no paid plans yet" goes above the
//     fold, not buried.
//   - Layer disclosure: three cards cover the 80%, FAQ handles the
//     edge questions ("will self-host stay free?", "can I move?").
//
// Content is the source of truth. See pd-12-monetization-deferred.md
// for the product rationale.

import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';

const SECTION_STYLE: React.CSSProperties = {
  maxWidth: 960,
  margin: '0 auto',
  padding: '56px 0',
};

const EYEBROW_STYLE: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  margin: '0 0 12px',
};

const H1_STYLE: React.CSSProperties = {
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontWeight: 400,
  fontSize: 52,
  lineHeight: 1.08,
  letterSpacing: '-0.025em',
  color: 'var(--ink)',
  margin: '0 0 20px',
  textWrap: 'balance' as unknown as 'balance',
};

const SUB_STYLE: React.CSSProperties = {
  fontSize: 18,
  lineHeight: 1.6,
  color: 'var(--muted)',
  margin: '0 auto',
  maxWidth: 620,
};

const CARD_STYLE: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 14,
  padding: '28px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  minHeight: 360,
};

const CARD_FEATURED_STYLE: React.CSSProperties = {
  ...CARD_STYLE,
  borderColor: 'var(--ink)',
  boxShadow: '0 12px 40px rgba(14,14,12,0.06)',
};

const CARD_TITLE_STYLE: React.CSSProperties = {
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontWeight: 400,
  fontSize: 24,
  letterSpacing: '-0.01em',
  color: 'var(--ink)',
  margin: 0,
};

const PRICE_STYLE: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 32,
  fontWeight: 600,
  color: 'var(--ink)',
  letterSpacing: '-0.02em',
  margin: 0,
};

const PRICE_NOTE_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--muted)',
  margin: '2px 0 0',
};

const FEATURE_LIST_STYLE: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: '8px 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const FEATURE_ITEM_STYLE: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  color: 'var(--ink)',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
};

const CTA_PRIMARY_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '10px 18px',
  borderRadius: 999,
  fontSize: 14,
  fontWeight: 600,
  textDecoration: 'none',
  background: 'var(--ink)',
  color: '#fff',
  border: '1px solid var(--ink)',
  marginTop: 'auto',
};

const CTA_SECONDARY_STYLE: React.CSSProperties = {
  ...CTA_PRIMARY_STYLE,
  background: 'transparent',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
};

interface Plan {
  name: string;
  eyebrow: string;
  price: string;
  priceNote: string;
  features: string[];
  cta: { label: string; to?: string; href?: string };
  featured?: boolean;
}

const PLANS: Plan[] = [
  {
    name: 'Self-host',
    eyebrow: 'Free forever',
    price: '$0',
    priceNote: 'MIT licensed. Your server, your rules.',
    features: [
      'Same Docker image as cloud',
      'All three surfaces: web form, MCP, HTTP',
      'Unlimited apps and runs (your infra)',
      'Rate limits, secret injection, renderer uploads',
    ],
    cta: {
      label: 'Self-host guide',
      href: 'https://github.com/floomhq/floom/blob/main/docs/SELF_HOST.md',
    },
  },
  {
    name: 'Cloud',
    eyebrow: 'Free during beta',
    price: '$0',
    priceNote: 'No credit card. Fair-use rate limits apply.',
    features: [
      'Paste a link, publish in under a minute',
      'Shareable /p/:slug pages + MCP endpoint',
      'Built-in auth, secrets, run history',
      'Managed hosting on floom.dev',
    ],
    cta: { label: 'Sign in free', to: '/login' },
    featured: true,
  },
  {
    name: 'Cloud Pro',
    eyebrow: 'Coming soon',
    price: 'TBD',
    priceNote: 'For creators monetizing their apps and teams with higher limits.',
    features: [
      'Higher run quotas and priority workers',
      'Creator monetization via Stripe Connect',
      'Workspace + team seats',
      'Email support with response SLAs',
    ],
    cta: {
      label: 'Watch for updates',
      href: 'https://github.com/floomhq/floom/releases',
    },
  },
];

interface Faq {
  q: string;
  a: React.ReactNode;
}

const FAQS: Faq[] = [
  {
    q: 'When do paid plans launch?',
    a: (
      <>
        No date yet. We'll only charge once cloud limits start biting real
        users. Track{' '}
        <Link to="/protocol" style={{ color: 'var(--ink)' }}>
          the protocol page
        </Link>{' '}
        and{' '}
        <a
          href="https://github.com/floomhq/floom/releases"
          style={{ color: 'var(--ink)' }}
        >
          GitHub releases
        </a>{' '}
        for changes.
      </>
    ),
  },
  {
    q: 'Will self-host stay free?',
    a: (
      <>
        Yes. Floom is MIT licensed. The self-host Docker image ships the same
        code that powers <code>floom.dev</code>. We don't plan to open-core
        core features behind a paywall.
      </>
    ),
  },
  {
    q: 'What are the cloud rate limits today?',
    a: (
      <>
        Per-IP and per-user sliding windows on run and job endpoints. The
        defaults are tuned for interactive use. If you hit a limit, you'll
        get a 429 with retry info; self-host removes it entirely.
      </>
    ),
  },
  {
    q: 'Can I move between cloud and self-host later?',
    a: (
      <>
        Yes. Apps are described by a portable manifest and OpenAPI spec. Point
        a self-host instance at the same spec and it will behave the same
        way. You don't get locked in.
      </>
    ),
  },
];

export function PricingPage() {
  return (
    <PageShell
      title="Pricing · Floom"
      contentStyle={{ padding: '24px 24px 80px', maxWidth: 1040 }}
    >
      <section
        data-testid="pricing-hero"
        style={{ ...SECTION_STYLE, padding: '72px 0 32px', textAlign: 'center' }}
      >
        <p style={{ ...EYEBROW_STYLE, textAlign: 'center' }}>Pricing</p>
        <h1 style={H1_STYLE}>Free today. Honest about tomorrow.</h1>
        <p style={SUB_STYLE}>
          Floom is pre-1.0. Cloud is free during beta, self-host is free
          forever, and paid plans don't exist yet. When they do, we'll say so
          here first.
        </p>
      </section>

      <section
        data-testid="pricing-plans"
        style={{ ...SECTION_STYLE, padding: '16px 0 56px' }}
      >
        <div
          className="pricing-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 20,
          }}
        >
          {PLANS.map((plan) => (
            <article
              key={plan.name}
              data-testid={`pricing-card-${plan.name.toLowerCase().replace(/\s+/g, '-')}`}
              style={plan.featured ? CARD_FEATURED_STYLE : CARD_STYLE}
            >
              <header>
                <p style={EYEBROW_STYLE}>{plan.eyebrow}</p>
                <h2 style={CARD_TITLE_STYLE}>{plan.name}</h2>
              </header>
              <div>
                <p style={PRICE_STYLE}>{plan.price}</p>
                <p style={PRICE_NOTE_STYLE}>{plan.priceNote}</p>
              </div>
              <ul style={FEATURE_LIST_STYLE}>
                {plan.features.map((f) => (
                  <li key={f} style={FEATURE_ITEM_STYLE}>
                    <span aria-hidden="true" style={{ color: 'var(--muted)' }}>
                      ·
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {plan.cta.href ? (
                <a
                  href={plan.cta.href}
                  target="_blank"
                  rel="noreferrer"
                  style={plan.featured ? CTA_PRIMARY_STYLE : CTA_SECONDARY_STYLE}
                >
                  {plan.cta.label}
                </a>
              ) : (
                <Link
                  to={plan.cta.to ?? '/'}
                  style={plan.featured ? CTA_PRIMARY_STYLE : CTA_SECONDARY_STYLE}
                >
                  {plan.cta.label}
                </Link>
              )}
            </article>
          ))}
        </div>
      </section>

      <section
        data-testid="pricing-faq"
        style={{
          ...SECTION_STYLE,
          padding: '56px 0',
          borderTop: '1px solid var(--line)',
          maxWidth: 720,
        }}
      >
        <h2
          style={{
            fontFamily: "'DM Serif Display', Georgia, serif",
            fontWeight: 400,
            fontSize: 28,
            letterSpacing: '-0.01em',
            color: 'var(--ink)',
            margin: '0 0 24px',
          }}
        >
          Questions people actually ask
        </h2>
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {FAQS.map((faq) => (
            <div key={faq.q}>
              <dt
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: 'var(--ink)',
                  margin: '0 0 6px',
                }}
              >
                {faq.q}
              </dt>
              <dd
                style={{
                  fontSize: 15,
                  lineHeight: 1.65,
                  color: 'var(--muted)',
                  margin: 0,
                }}
              >
                {faq.a}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <style>{`
        @media (max-width: 720px) {
          [data-testid="pricing-plans"] .pricing-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </PageShell>
  );
}
