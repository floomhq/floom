// /waitlist — "what to expect" landing + email capture (issue #591).
//
// 2026-04-24 trim (Federico): page was 5 bands and felt messy for a
// signup page. Cut to 3 bands, aligned H1 with landing ("Ship AI apps
// fast.") so the positioning is consistent everywhere, and killed the
// "Who it's for" makers+teams duplicate (landing already covers this
// with "Two audiences. One runtime.").
//
// Layout:
//   1. Hero — launch pill + H1 + subhead + email form + repo link
//   2. "What's shipping" — 3 cards: self-host, apps, publish (#692)
//   3. Timeline band (dark): "Going live Launch Week: 27 April 2026"
//   + Footer link row to /docs + /apps
//
// Design rules (MEMORY): restrained palette, real lucide icons, no emojis,
// no text-in-circles, no pure black, warm dark surface uses `#1b1a17`.
// Display font via `var(--font-display)`. Primary accent = `var(--accent)`.
//
// The email form, its testids, and the submitWaitlist call are preserved
// exactly so tests + the backend endpoint keep working.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Layers,
  Rocket,
  Server,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { PageShell } from '../components/PageShell';
import { submitWaitlist, ApiError } from '../api/client';
import { track } from '../lib/posthog';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Vision band (hero) ---------------------------------------------------

const HERO_SECTION: CSSProperties = {
  maxWidth: 720,
  margin: '0 auto',
  padding: '64px 0 40px',
  textAlign: 'center',
};

const EYEBROW_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  margin: '0 0 14px',
};

// Launch Week pill — neutral #f5f5f3 bg, #1b1a17 ink, green accent dot.
// Contrast on #f5f5f3: #1b1a17 = 16.1:1 (AAA). Color is NOT the info carrier —
// the text "Launch week · 27 April 2026" carries the meaning on its own.
const LAUNCH_PILL_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 14px',
  borderRadius: 999,
  background: '#f5f5f3',
  border: '1px solid var(--line)',
  color: '#1b1a17',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  margin: '0 0 18px',
};

const LAUNCH_PILL_DOT: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: 'var(--accent)',
  flex: '0 0 auto',
};

const H1_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  fontSize: 52,
  lineHeight: 1.08,
  letterSpacing: '-0.025em',
  color: 'var(--ink)',
  margin: '0 0 16px',
  textWrap: 'balance' as unknown as 'balance',
};

// Subhead carries the positioning line, matching the landing page's
// "The protocol and runtime for agentic work." Rendered slightly smaller
// than the H1 but heavier than the lede so the positioning reads as the
// second-most-important line on the page.
const SUBHEAD_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 22,
  lineHeight: 1.35,
  fontWeight: 500,
  color: 'var(--ink)',
  margin: '0 auto 16px',
  maxWidth: 620,
  letterSpacing: '-0.01em',
};

const LEDE_STYLE: CSSProperties = {
  fontSize: 18,
  lineHeight: 1.6,
  color: 'var(--muted)',
  margin: '0 auto 8px',
  maxWidth: 560,
};

const MICRO_STYLE: CSSProperties = {
  fontSize: 13,
  color: 'var(--muted)',
  margin: '0 auto',
  maxWidth: 520,
  opacity: 0.85,
};

// ---- Email form -----------------------------------------------------------

const FORM_SECTION: CSSProperties = {
  maxWidth: 560,
  margin: '0 auto',
  padding: '0 0 32px',
};

const FORM_CARD: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 16,
  padding: '28px 28px 24px',
};

const FORM_ROW: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const INPUT_STYLE: CSSProperties = {
  flex: '1 1 240px',
  minWidth: 0,
  padding: '12px 14px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--bg)',
  color: 'var(--ink)',
  fontSize: 15,
};

const BUTTON_STYLE: CSSProperties = {
  padding: '12px 20px',
  border: 'none',
  borderRadius: 8,
  background: 'var(--ink)',
  color: '#fff',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

// ---- Shipping cards -------------------------------------------------------

interface ShippingCard {
  icon: typeof Rocket;
  title: string;
  body: string;
  cta: { label: string; to: string };
}

// 2026-04-24: reordered to put Self-host first. Federico's ask is to
// lead with "Floom is already live today" — self-host is the thing that
// actually works right now, so it goes first. Cloud (the thing you're
// on the waitlist for) opens 27 April. Launch apps + Publish flow stay
// as the things that will light up when Cloud opens.
const SHIPPING: ShippingCard[] = [
  {
    icon: Server,
    title: 'Self-host today',
    body: 'Run Floom on your own server with one Docker command. Open source, public repo, no waitlist, no signup. Already live.',
    cta: { label: 'Self-host guide', to: '/docs/self-host' },
  },
  {
    icon: Rocket,
    title: 'Launch apps to run now',
    body: 'Lead Scorer, Resume Screener, Competitor Analyzer: real AI apps doing real work. No account needed to try them.',
    cta: { label: 'Browse the store', to: '/apps' },
  },
  {
    icon: Layers,
    title: 'Publish any OpenAPI',
    body: 'Paste an OpenAPI URL, get three surfaces at once: a web page, an MCP server, and a typed HTTP endpoint.',
    cta: { label: 'Read the docs', to: '/docs' },
  },
];

const SHIPPING_SECTION: CSSProperties = {
  maxWidth: 1080,
  margin: '0 auto',
  padding: '48px 0 16px',
};

const SECTION_HEAD_EYEBROW: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  margin: '0 0 10px',
  textAlign: 'center',
};

const SECTION_H2: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 32,
  lineHeight: 1.15,
  letterSpacing: '-0.02em',
  color: 'var(--ink)',
  margin: '0 0 28px',
  textAlign: 'center',
};

const SHIPPING_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 14,
};

const CARD_STYLE: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 14,
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  minWidth: 0,
};

const ICON_BADGE: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 10,
  background: '#ecfdf5',
  color: 'var(--accent)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const CARD_TITLE: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: 'var(--ink)',
  margin: 0,
  letterSpacing: '-0.01em',
  lineHeight: 1.25,
};

const CARD_BODY: CSSProperties = {
  fontSize: 13.5,
  color: 'var(--muted)',
  lineHeight: 1.55,
  margin: 0,
  flex: 1,
};

const CARD_LINK: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--accent)',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  marginTop: 4,
};

// ---- Timeline band --------------------------------------------------------

const TIMELINE_BAND: CSSProperties = {
  maxWidth: 720,
  margin: '0 auto',
  padding: '32px 24px',
  textAlign: 'center',
  background: '#1b1a17',
  color: '#f5f5f3',
  borderRadius: 14,
  marginTop: 32,
  marginBottom: 32,
};

const TIMELINE_EYEBROW: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  fontWeight: 700,
  color: '#9a9790',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  margin: '0 0 8px',
};

const TIMELINE_LINE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 20,
  lineHeight: 1.4,
  fontWeight: 600,
  color: '#f5f5f3',
  margin: 0,
  letterSpacing: '-0.01em',
};

// ---- Footer links ---------------------------------------------------------

const FOOTER_LINKS: CSSProperties = {
  textAlign: 'center',
  padding: '16px 0 32px',
  fontSize: 13,
  color: 'var(--muted)',
};

const FOOTER_LINK: CSSProperties = {
  color: 'var(--ink)',
  fontWeight: 600,
  textDecoration: 'underline',
  textUnderlineOffset: 3,
};

// ---------------------------------------------------------------------------

export function WaitlistPage() {
  const [email, setEmail] = useState('');
  const [showDeployDetails, setShowDeployDetails] = useState(false);
  const [deployRepoUrl, setDeployRepoUrl] = useState('');
  const [deployIntent, setDeployIntent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError('Please enter a valid email address.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await submitWaitlist({
        email: trimmed,
        source: 'direct',
        deploy_repo_url: deployRepoUrl,
        deploy_intent: deployIntent,
      });
      // Analytics #599: mirror the WaitlistModal emit for the standalone
      // /waitlist page so direct visitors are counted in the same funnel.
      track('waitlist_join', { source: 'direct' });
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setError('Too many signups from this network. Try again in an hour.');
        } else if (err.status === 400) {
          if (err.message === 'invalid_deploy_repo_url') {
            setError('Use a valid http(s) link for the repo, e.g. https://github.com/org/repo');
          } else if (err.message === 'invalid_deploy_intent') {
            setError('Description must be 2000 characters or less.');
          } else {
            setError('That email looked invalid to the server. Double-check and retry.');
          }
        } else {
          setError('Something went wrong on our end. Please try again.');
        }
      } else {
        // Audit 2026-04-24: softened "Check your connection" wording so
        // a cold-start doesn't read as the user's own network being down.
        setError("Couldn't submit. Give it a moment and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageShell
      title="Join the Floom waitlist"
      description="Floom is already live. Self-host today with one Docker command, or join the waitlist for Floom Cloud, going live 27 April 2026."
      contentStyle={{ maxWidth: 1120 }}
    >
      {/* 1. Hero ----------------------------------------------------------- */}
      {/* 2026-04-24 hero trim: killed the "Waitlist" eyebrow (the pill already
          anchors launch week, and the page title handles the route context).
          Merged lede + micro into one line so the form sits higher on the
          viewport. Federico: "so much bloat?" */}
      <section style={HERO_SECTION} data-testid="waitlist-hero">
        <div
          style={LAUNCH_PILL_STYLE}
          data-testid="waitlist-launch-pill"
          aria-label="Launch week 27 April 2026"
        >
          <span aria-hidden="true" style={LAUNCH_PILL_DOT} />
          Launch week &middot; 27 April 2026
        </div>
        <h1 style={H1_STYLE}>Ship AI apps fast.</h1>
        <p style={SUBHEAD_STYLE}>The protocol and runtime for agentic work.</p>
        <p style={LEDE_STYLE}>
          Self-host today. Cloud goes live 27 April. Drop your email and
          we&rsquo;ll let you in.
        </p>
      </section>

      {/* 2. Email form ----------------------------------------------------- */}
      <section style={FORM_SECTION}>
        <div style={FORM_CARD}>
          {success ? (
            <div style={{ textAlign: 'center' }}>
              <p
                style={{
                  fontSize: 16,
                  lineHeight: 1.55,
                  color: 'var(--ink)',
                  margin: '0 0 16px',
                  fontWeight: 600,
                }}
                data-testid="waitlist-page-success"
              >
                You&rsquo;re on the list.
              </p>
              <p
                style={{
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: 'var(--muted)',
                  margin: '0 0 20px',
                }}
              >
                We&rsquo;ll email you the moment Floom Cloud opens (27 April
                2026). Don&rsquo;t want to wait? Self-host today, one Docker
                command, no signup.
              </p>
              <div
                style={{
                  display: 'flex',
                  gap: 10,
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <Link
                  to="/docs/self-host"
                  data-testid="waitlist-success-self-host"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '10px 18px',
                    borderRadius: 8,
                    background: 'var(--ink)',
                    color: '#fff',
                    textDecoration: 'none',
                    fontSize: 14,
                    fontWeight: 600,
                  }}
                >
                  Self-host now
                  <ArrowRight size={14} strokeWidth={2} />
                </Link>
                <Link
                  to="/apps"
                  data-testid="waitlist-success-browse"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '10px 18px',
                    borderRadius: 8,
                    background: 'transparent',
                    color: 'var(--ink)',
                    border: '1px solid var(--line)',
                    textDecoration: 'none',
                    fontSize: 14,
                    fontWeight: 600,
                  }}
                >
                  Browse the store
                  <ArrowRight size={14} strokeWidth={2} />
                </Link>
              </div>
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit} data-testid="waitlist-page-form">
                <div style={FORM_ROW}>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (error) setError(null);
                    }}
                    placeholder="you@example.com"
                    data-testid="waitlist-page-email"
                    autoComplete="email"
                    spellCheck={false}
                    disabled={submitting}
                    aria-label="Email address"
                    style={{
                      ...INPUT_STYLE,
                      border: `1px solid ${error ? 'var(--danger, #e5484d)' : 'var(--line)'}`,
                    }}
                  />
                  <button
                    type="submit"
                    disabled={submitting}
                    data-testid="waitlist-page-submit"
                    style={{
                      ...BUTTON_STYLE,
                      opacity: submitting ? 0.7 : 1,
                      cursor: submitting ? 'default' : 'pointer',
                    }}
                  >
                    {submitting ? 'Joining…' : 'Join waitlist'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setShowDeployDetails((v) => !v)}
                  data-testid="waitlist-page-toggle-details"
                  disabled={submitting}
                  style={{
                    display: 'block',
                    width: '100%',
                    marginTop: 12,
                    marginBottom: showDeployDetails ? 12 : 0,
                    padding: 0,
                    border: 'none',
                    background: 'none',
                    color: 'var(--muted)',
                    fontSize: 12,
                    fontWeight: 600,
                    textAlign: 'left',
                    cursor: submitting ? 'default' : 'pointer',
                    textDecoration: 'underline',
                    textUnderlineOffset: 2,
                  }}
                >
                  {showDeployDetails ? '− Hide' : '+'} What do you want to deploy? (optional)
                </button>
                {showDeployDetails && (
                  <div style={{ marginBottom: 4 }}>
                    <label
                      style={{
                        display: 'block',
                        fontSize: 12,
                        fontWeight: 600,
                        color: 'var(--muted)',
                        marginBottom: 6,
                      }}
                      htmlFor="waitlist-page-repo-url"
                    >
                      Repo URL
                    </label>
                    <input
                      id="waitlist-page-repo-url"
                      type="url"
                      inputMode="url"
                      value={deployRepoUrl}
                      onChange={(e) => {
                        setDeployRepoUrl(e.target.value);
                        if (error) setError(null);
                      }}
                      placeholder="github.com/yourname/your-repo"
                      data-testid="waitlist-page-repo-url"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={submitting}
                      style={{
                        ...INPUT_STYLE,
                        width: '100%',
                        marginBottom: 12,
                        boxSizing: 'border-box',
                      }}
                    />
                    <label
                      style={{
                        display: 'block',
                        fontSize: 12,
                        fontWeight: 600,
                        color: 'var(--muted)',
                        marginBottom: 6,
                      }}
                      htmlFor="waitlist-page-deploy-intent"
                    >
                      Tell us about it
                    </label>
                    <textarea
                      id="waitlist-page-deploy-intent"
                      value={deployIntent}
                      onChange={(e) => {
                        setDeployIntent(e.target.value);
                        if (error) setError(null);
                      }}
                      placeholder="What does it do? Who's it for?"
                      data-testid="waitlist-page-deploy-intent"
                      rows={3}
                      disabled={submitting}
                      style={{
                        ...INPUT_STYLE,
                        width: '100%',
                        boxSizing: 'border-box',
                        resize: 'vertical',
                        minHeight: 72,
                        fontFamily: 'inherit',
                      }}
                    />
                  </div>
                )}
              </form>
              {error && (
                <div
                  data-testid="waitlist-page-error"
                  role="alert"
                  style={{
                    marginTop: 12,
                    color: 'var(--danger, #e5484d)',
                    fontSize: 13,
                  }}
                >
                  {error}
                </div>
              )}
            </>
          )}
        </div>
        {/* Secondary "view the repo" link — small, below the card. Federico
            2026-04-24: the repo is public, users should be able to reach
            it in one click without scrolling to the self-host card. */}
        {!success && (
          <div
            style={{
              textAlign: 'center',
              marginTop: 14,
              fontSize: 13,
              color: 'var(--muted)',
            }}
          >
            Can&rsquo;t wait?{' '}
            <a
              href="https://github.com/floomhq/floom"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="waitlist-repo-link"
              style={{
                color: 'var(--ink)',
                fontWeight: 600,
                textDecoration: 'underline',
                textUnderlineOffset: 3,
              }}
            >
              View the repo on GitHub
            </a>{' '}
            and self-host today.
          </div>
        )}
      </section>

      {/* 2. What's shipping ----------------------------------------------- */}
      <section style={SHIPPING_SECTION} data-testid="waitlist-shipping">
        <div style={SECTION_HEAD_EYEBROW}>What&rsquo;s shipping</div>
        <h2 style={SECTION_H2}>Self-host today. Cloud in a week.</h2>
        <div className="waitlist-shipping-grid" style={SHIPPING_GRID}>
          {SHIPPING.map((card) => {
            const Icon = card.icon;
            return (
              <article key={card.title} style={CARD_STYLE}>
                <span aria-hidden="true" style={ICON_BADGE}>
                  <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <h3 style={CARD_TITLE}>{card.title}</h3>
                <p style={CARD_BODY}>{card.body}</p>
                <Link to={card.cta.to} style={CARD_LINK}>
                  {card.cta.label}
                  <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
                </Link>
              </article>
            );
          })}
        </div>
      </section>

      {/* 3. Timeline band -------------------------------------------------- */}
      <section style={TIMELINE_BAND} data-testid="waitlist-timeline">
        <div style={TIMELINE_EYEBROW}>Timeline</div>
        <p style={TIMELINE_LINE}>
          Going live Launch Week: 27 April 2026. The waitlist opens access as
          we scale.
        </p>
      </section>

      {/* Footer links ------------------------------------------------------ */}
      <div style={FOOTER_LINKS}>
        Already exploring? Poke around{' '}
        <Link to="/docs" style={FOOTER_LINK}>
          the docs
        </Link>
        {' '}or run an app on{' '}
        <Link to="/apps" style={FOOTER_LINK}>
          the store
        </Link>
        .
      </div>

      <style>{`
        @media (max-width: 860px) {
          .waitlist-shipping-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
        @media (max-width: 560px) {
          [data-testid="waitlist-hero"] h1 { font-size: 36px !important; }
        }
      `}</style>
    </PageShell>
  );
}
