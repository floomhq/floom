// Pre-launch P0: password-reset confirmation page.
//
// Reached via the email link from ForgotPasswordPage. Better Auth emails
// a URL to `/auth/reset-password/<token>?callbackURL=<origin>/reset-password`;
// Better Auth's callback validates the token and redirects to
// `<origin>/reset-password?token=<token>`. This component reads that
// `?token=` query param, shows a new-password + confirm form, and POSTs
// to `/auth/reset-password?token=<token>`.
//
// Missing/invalid token states show a friendly error instead of a blank
// form so users can recover by going back to /forgot-password.

import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import * as api from '../api/client';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    if (!token) {
      setState('error');
      setErrorMsg('This link is missing a token. Request a new reset email.');
      return;
    }
    if (password.length < 8) {
      setState('error');
      setErrorMsg('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setState('error');
      setErrorMsg('Passwords do not match.');
      return;
    }
    setState('submitting');
    try {
      await api.resetPassword({ newPassword: password, token });
      setState('done');
      // Small delay so the user sees the success state before the
      // redirect — feels less abrupt than an instant flash.
      setTimeout(() => {
        navigate('/login?reset=1', { replace: true });
      }, 1200);
    } catch (err) {
      setState('error');
      const e = err as { message?: string; status?: number };
      // Better Auth returns 400 with a message when the token is
      // invalid/expired. Surface that to the user so they know to
      // request a new link.
      setErrorMsg(
        e.message ||
          'Could not reset password. The link may have expired. Request a new one.',
      );
    }
  }

  // Missing token: skip the form entirely and point the user back.
  if (!token) {
    return (
      <PageShell title="Reset your password · Floom">
        <div
          style={{ maxWidth: 440, margin: '40px auto', padding: '0 16px' }}
          data-testid="reset-password-invalid"
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
            Link invalid
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
            This reset link is missing a token. Request a new one.
          </p>
          <div style={{ textAlign: 'center' }}>
            <Link
              to="/forgot-password"
              style={{
                display: 'inline-block',
                padding: '10px 16px',
                background: 'var(--accent)',
                color: '#fff',
                border: '1px solid var(--accent)',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Request new link
            </Link>
          </div>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="Reset your password · Floom">
      <div
        style={{ maxWidth: 440, margin: '40px auto', padding: '0 16px' }}
        data-testid="reset-password-page"
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
          Choose a new password
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
          {state === 'done'
            ? 'Password updated. Taking you to sign in\u2026'
            : 'At least 8 characters. Keep it strong.'}
        </p>

        {state !== 'done' && (
          <form onSubmit={handleSubmit} data-testid="reset-password-form">
            <label htmlFor="reset-new" style={labelStyle}>
              New password
            </label>
            <input
              id="reset-new"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoFocus
              autoComplete="new-password"
              placeholder="At least 8 characters"
              data-testid="reset-password-new"
              style={inputStyle}
            />
            <label htmlFor="reset-confirm" style={labelStyle}>
              Confirm password
            </label>
            <input
              id="reset-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="Repeat the password"
              data-testid="reset-password-confirm"
              style={inputStyle}
            />
            {state === 'error' && (
              <div
                data-testid="reset-password-error"
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
              data-testid="reset-password-submit"
              style={{
                ...primaryButtonStyle,
                opacity: state === 'submitting' ? 0.7 : 1,
                cursor: state === 'submitting' ? 'not-allowed' : 'pointer',
              }}
            >
              {state === 'submitting' ? 'Updating...' : 'Update password'}
            </button>
          </form>
        )}

        {state === 'done' && (
          <div
            data-testid="reset-password-done"
            style={{
              background: '#ecfdf5',
              border: '1px solid #b7ebd3',
              color: '#0f5132',
              borderRadius: 10,
              padding: '16px 16px',
              fontSize: 14,
              lineHeight: 1.55,
              textAlign: 'center',
            }}
          >
            Password updated. Redirecting you to sign in&hellip;
          </div>
        )}
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
