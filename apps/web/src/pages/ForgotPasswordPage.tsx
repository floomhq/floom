// Pre-launch P0: real password-reset request form. Replaces the old
// `mailto:team@floom.dev` link on /login, which dumped users into their
// mail client and asked Federico to reset passwords by hand.
//
// Flow:
//   1. User enters email → POST /auth/request-password-reset.
//   2. Better Auth's `sendResetPassword` hook (apps/server/src/lib/
//      better-auth.ts) emails them a link back to /reset-password?token=…
//   3. We always show the same "check your email" state regardless of
//      whether the email actually exists on record — Better Auth returns
//      200 either way for anti-enumeration, and we match that guarantee
//      in the UI.
//
// v23 PR-F (decision doc /tmp/wireframe-react/auth-decision.md):
//   - Wraps the form in <AuthCard> (shared chrome with /login, /signup,
//     /reset-password) — D-section + A-section.
//   - Heading: `Reset your password.` (request) / `Check your inbox.`
//     (sent), per D1/D3.
//   - Sent-state subhead: echoes the entered email but does NOT claim
//     the email exists in our DB (Flag #2 default) — anti-enumeration
//     preserved while matching wireframe parity.
//   - Sent confirmation pill: green-soft bg + check icon + "Sent." +
//     30s resend countdown link (D5).
//   - Footer link: `Sign in →` with arrow per D7.
//   - Primary CTA stays emerald (D6: brief overrides wireframe's
//     btn-ink).
//
// The `redirectTo` param is the frontend URL Better Auth sends users to
// after validating the token on the GET callback; it appends the token
// as `?token=<token>` when it redirects.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import {
  AuthCard,
  authH1Style,
  authSubStyle,
  authLabelStyle,
  authInputStyle,
  authPrimaryButtonStyle,
} from '../components/auth/AuthCard';
import * as api from '../api/client';

const RESEND_COOLDOWN_SECONDS = 30;

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submittedEmail, setSubmittedEmail] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [resendError, setResendError] = useState('');

  // Tick the resend cooldown once a second. Stops at 0 so the user can
  // tap "resend" again. Clears on unmount or when the user lands back
  // in the request state (state !== 'sent' resets the counter).
  useEffect(() => {
    if (state !== 'sent' || resendIn <= 0) return;
    const id = window.setInterval(() => {
      setResendIn((n) => Math.max(0, n - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [state, resendIn]);

  async function sendReset(target: string): Promise<boolean> {
    setErrorMsg('');
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      await api.requestPasswordReset({
        email: target,
        redirectTo: `${origin}/reset-password`,
      });
      return true;
    } catch (err) {
      // Better Auth returns 200 for enumeration safety even when the
      // email doesn't exist, so a non-200 here is a real infrastructure
      // error. Show the server message if we have one, else a generic.
      const e = err as { message?: string };
      setErrorMsg(e.message || 'Something went wrong. Try again in a moment.');
      return false;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const target = email.trim();
    if (!target) return;
    setState('submitting');
    const ok = await sendReset(target);
    if (ok) {
      setSubmittedEmail(target);
      setResendIn(RESEND_COOLDOWN_SECONDS);
      setState('sent');
    } else {
      setState('error');
    }
  }

  async function handleResend() {
    if (resendIn > 0 || !submittedEmail) return;
    setResendError('');
    const ok = await sendReset(submittedEmail);
    if (ok) {
      setResendIn(RESEND_COOLDOWN_SECONDS);
    } else {
      // Surface the error inline without leaving the sent state — the
      // user already saw their email confirmed, so we don't want to
      // visually regress to the request form on a transient infra error.
      setResendError(errorMsg || 'Could not resend. Try again in a moment.');
    }
  }

  const isSent = state === 'sent';

  return (
    <PageShell title="Reset your password · Floom" noIndex>
      <AuthCard dataTestId="forgot-password-page">
        <h1 style={authH1Style}>
          {isSent ? 'Check your inbox.' : 'Reset your password.'}
        </h1>
        <p style={authSubStyle}>
          {isSent ? (
            <>
              We sent a reset link to{' '}
              <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>
                {submittedEmail}
              </strong>
              . Click it within 15 minutes to set a new password.
            </>
          ) : (
            "Enter the email on your account. We'll send a reset link valid for 15 minutes."
          )}
        </p>

        {isSent ? (
          <>
            <div
              data-testid="forgot-password-sent-pill"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '14px 16px',
                background: 'var(--accent-soft)',
                border: '1px solid var(--accent-border)',
                borderRadius: 12,
                fontSize: 12.5,
                color: 'var(--ink)',
                lineHeight: 1.55,
                marginTop: 4,
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width={18}
                height={18}
                stroke="currentColor"
                fill="none"
                strokeWidth={1.75}
                style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }}
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <div>
                <strong style={{ fontWeight: 600 }}>Sent.</strong> Didn&rsquo;t arrive? Check spam, or{' '}
                <button
                  type="button"
                  onClick={() => void handleResend()}
                  disabled={resendIn > 0}
                  data-testid="forgot-password-resend"
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: resendIn > 0 ? 'var(--muted)' : 'var(--accent)',
                    fontWeight: 600,
                    fontSize: 'inherit',
                    fontFamily: 'inherit',
                    textDecoration: 'underline',
                    cursor: resendIn > 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  {resendIn > 0 ? `resend in ${resendIn}s` : 'resend now'}
                </button>
                .
              </div>
            </div>
            {resendError && (
              <div
                data-testid="forgot-password-resend-error"
                style={{
                  margin: '12px 0 0',
                  padding: '10px 12px',
                  background: '#fff8e6',
                  border: '1px solid #f4e0a5',
                  borderRadius: 8,
                  fontSize: 13,
                  color: '#8a5a00',
                  lineHeight: 1.5,
                }}
              >
                {resendError}
              </div>
            )}
          </>
        ) : (
          <form onSubmit={handleSubmit} data-testid="forgot-password-form">
            <label htmlFor="forgot-email" style={authLabelStyle}>
              Email
            </label>
            <input
              id="forgot-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
              placeholder="you@example.com"
              data-testid="forgot-password-email"
              style={authInputStyle}
            />
            {state === 'error' && (
              <div
                data-testid="forgot-password-error"
                style={{
                  margin: '8px 0 12px',
                  padding: '10px 12px',
                  background: '#fff8e6',
                  border: '1px solid #f4e0a5',
                  borderRadius: 8,
                  fontSize: 13,
                  color: '#8a5a00',
                  lineHeight: 1.5,
                }}
              >
                {errorMsg}
              </div>
            )}
            <button
              type="submit"
              disabled={state === 'submitting'}
              data-testid="forgot-password-submit"
              style={{
                ...authPrimaryButtonStyle,
                opacity: state === 'submitting' ? 0.7 : 1,
                cursor: state === 'submitting' ? 'not-allowed' : 'pointer',
              }}
            >
              {state === 'submitting' ? 'Sending...' : 'Send reset link'}
            </button>
          </form>
        )}

        <p
          style={{
            textAlign: 'center',
            margin: '24px 0 0',
            fontSize: 13,
            color: 'var(--muted)',
          }}
        >
          Remembered it?{' '}
          <Link
            to="/login"
            data-testid="forgot-password-signin-link"
            style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
          >
            Sign in &rarr;
          </Link>
        </p>
      </AuthCard>
    </PageShell>
  );
}
