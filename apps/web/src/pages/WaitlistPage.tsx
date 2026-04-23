// /waitlist — full-page fallback for the deploy waitlist (launch 2026-04-27).
//
// The primary surface for joining the waitlist is the WaitlistModal
// (see components/WaitlistModal.tsx), popped from every gated
// Deploy/Publish CTA. This page is the URL we link to from the
// confirmation email ("if you lost the modal, go here") and the
// bare-bones destination `/deploy` and other removed flows can
// redirect to when DEPLOY_ENABLED=false.
//
// Deliberately minimal: header, logo, short pitch, the same email form
// as the modal, and the same success state. Layout borrows from
// PricingPage + ChangelogPage so it slots into the v17 page shell
// family without a new pattern.

import { useState } from 'react';
import { PageShell } from '../components/PageShell';
import { submitWaitlist, ApiError } from '../api/client';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SECTION_STYLE: React.CSSProperties = {
  maxWidth: 560,
  margin: '0 auto',
  padding: '64px 0',
  textAlign: 'center',
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
  margin: '0 auto 28px',
  maxWidth: 480,
};

const FORM_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  maxWidth: 420,
  margin: '0 auto',
  flexWrap: 'wrap',
  justifyContent: 'center',
};

const INPUT_STYLE: React.CSSProperties = {
  flex: '1 1 220px',
  minWidth: 220,
  padding: '12px 14px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  color: 'var(--ink)',
  fontSize: 15,
};

const BUTTON_STYLE: React.CSSProperties = {
  padding: '12px 20px',
  border: 'none',
  borderRadius: 8,
  background: 'var(--ink)',
  color: '#fff',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};

export function WaitlistPage() {
  const [email, setEmail] = useState('');
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
      await submitWaitlist({ email: trimmed, source: 'direct' });
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setError('Too many signups from this network. Try again in an hour.');
        } else if (err.status === 400) {
          setError('That email looked invalid to the server. Double-check and retry.');
        } else {
          setError('Something went wrong on our end. Please try again.');
        }
      } else {
        setError('Network error. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageShell>
      <section style={SECTION_STYLE}>
        <div style={EYEBROW_STYLE}>Waitlist</div>
        <h1 style={H1_STYLE}>Join the Floom waitlist.</h1>
        {success ? (
          <>
            <p style={SUB_STYLE} data-testid="waitlist-page-success">
              You&rsquo;re on the list. We&rsquo;ll email you when your slot
              opens. In the meantime, the featured apps on the Floom store are
              free to run — no signup required.
            </p>
            <a
              href="/apps"
              style={{
                display: 'inline-block',
                padding: '12px 20px',
                borderRadius: 8,
                background: 'var(--ink)',
                color: '#fff',
                textDecoration: 'none',
                fontSize: 15,
                fontWeight: 600,
              }}
            >
              Browse the store
            </a>
          </>
        ) : (
          <>
            <p style={SUB_STYLE}>
              We&rsquo;re rolling out Deploy slowly. Drop your email and
              we&rsquo;ll let you know as soon as you can publish your own
              app.
            </p>
            <form
              onSubmit={handleSubmit}
              style={FORM_STYLE}
              data-testid="waitlist-page-form"
            >
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
      </section>
    </PageShell>
  );
}
