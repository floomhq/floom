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

const FORM_WRAP_STYLE: React.CSSProperties = {
  maxWidth: 420,
  margin: '0 auto',
  textAlign: 'left' as const,
};

const FORM_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: 8,
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
        setError('Network error. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageShell
      title="Join the Floom waitlist"
      description="Floom Cloud is rolling out in waves. Tell us what you'd deploy first and we'll let you in as soon as we can."
    >
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
            <div style={FORM_WRAP_STYLE}>
              <form onSubmit={handleSubmit} data-testid="waitlist-page-form">
                <div style={FORM_STYLE}>
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
                    marginTop: 10,
                    marginBottom: showDeployDetails ? 10 : 0,
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
            </div>
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
