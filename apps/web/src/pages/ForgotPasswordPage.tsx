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
//      in the UI so an attacker can't tell a real address from a typo.
//
// The `redirectTo` param is the frontend URL Better Auth sends users to
// after validating the token on the GET callback; it appends the token
// as `?token=<token>` when it redirects.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import * as api from '../api/client';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState('submitting');
    setErrorMsg('');
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      await api.requestPasswordReset({
        email: email.trim(),
        redirectTo: `${origin}/reset-password`,
      });
      setState('sent');
    } catch (err) {
      // Better Auth returns 200 for enumeration safety even when the
      // email doesn't exist, so a non-200 here is a real infrastructure
      // error. Show the server message if we have one, else a generic.
      setState('error');
      const e = err as { message?: string };
      setErrorMsg(e.message || 'Something went wrong. Try again in a moment.');
    }
  }

  return (
    <PageShell title="Reset your password · Floom" noIndex>
      <div
        style={{
          maxWidth: 440,
          margin: '40px auto',
          padding: '0 16px',
        }}
        data-testid="forgot-password-page"
      >
        <h1
          style={{
            fontSize: 28,
            fontWeight: 700,
            margin: '0 0 8px',
            color: 'var(--ink)',
            textAlign: 'center',
          }}
        >
          Reset your password
        </h1>
        <p
          style={{
            fontSize: 14,
            color: 'var(--muted)',
            margin: '0 0 24px',
            textAlign: 'center',
            lineHeight: 1.55,
          }}
        >
          {state === 'sent'
            ? "We sent you a link if the email matches a Floom account."
            : 'Enter your email and we\u2019ll send you a link to pick a new password.'}
        </p>

        {state === 'sent' ? (
          <div
            data-testid="forgot-password-sent"
            style={{
              background: '#ecfdf5',
              border: '1px solid #b7ebd3',
              color: '#0f5132',
              borderRadius: 10,
              padding: '16px 16px',
              fontSize: 14,
              lineHeight: 1.55,
              marginBottom: 16,
            }}
          >
            <strong style={{ display: 'block', marginBottom: 4 }}>Check your email.</strong>
            The reset link expires in 1 hour. Didn&rsquo;t get anything? Check spam, or try
            again with a different address.
          </div>
        ) : (
          <form onSubmit={handleSubmit} data-testid="forgot-password-form">
            <label htmlFor="forgot-email" style={labelStyle}>
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
              style={inputStyle}
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
                ...primaryButtonStyle,
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
            style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </PageShell>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--muted)',
  marginBottom: 6,
  marginTop: 12,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  fontSize: 14,
  color: 'var(--ink)',
  fontFamily: 'inherit',
  marginBottom: 8,
  boxSizing: 'border-box',
};

const primaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  background: 'var(--accent)',
  color: '#fff',
  border: '1px solid var(--accent)',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
  marginTop: 12,
  boxShadow: '0 4px 14px rgba(5,150,105,0.28), inset 0 1px 0 rgba(255,255,255,0.18)',
};
