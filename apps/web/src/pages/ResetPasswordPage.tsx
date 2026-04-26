// Pre-launch P0: password-reset confirmation page.
//
// Reached via the email link from ForgotPasswordPage. Better Auth emails
// a URL to `/auth/reset-password/<token>?callbackURL=<origin>/reset-password`;
// Better Auth's callback validates the token and redirects to
// `<origin>/reset-password?token=<token>`. This component reads that
// `?token=` query param, shows a new-password + confirm form, and POSTs
// to `/auth/reset-password?token=<token>`.
//
// Three states:
//   - valid token (default) — show the form
//   - expired token (`?expired=1` query param OR submit returns "expired"
//     error) — show the wireframe's expired-link UX
//   - missing token (no `?token=` at all) — minimal "Link invalid" state
//     directing the user to /forgot-password
//
// v23 PR-F (decision doc /tmp/wireframe-react/auth-decision.md):
//   - Wraps every state in <AuthCard> for shared chrome.
//   - Heading: `Set a new password.` (period). E1.
//   - Subhead: `Make it strong — you'll use it to sign in across web,
//     CLI, and agent flows.` E2.
//   - Confirm field label: `Confirm` (one word). Placeholder
//     `Type it again`. E4.
//   - Live password-rules block: 8+ chars, 1 uppercase, 1 number,
//     match. Visual hints only — submit only blocks on length + match
//     (Flag #3 default — uppercase + number are advisory until Better
//     Auth's policy is verified).
//   - Expired-token state via `?expired=1` (E9): heading `Link
//     expired.`, err-state body, CTA `Send a new reset link` →
//     /forgot-password, footer `Back to sign in` → /login.
//   - Footer link `Back to sign in` on the valid-token state (E7).
//   - Primary CTA stays emerald (E6: brief overrides wireframe btn-ink).

import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
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

interface PasswordRule {
  id: string;
  label: string;
  /** Whether this rule is satisfied by the current password / confirm. */
  passes: (password: string, confirm: string) => boolean;
}

const RULES: PasswordRule[] = [
  { id: 'len', label: '8+ characters', passes: (p) => p.length >= 8 },
  { id: 'upper', label: '1 uppercase letter', passes: (p) => /[A-Z]/.test(p) },
  { id: 'num', label: '1 number', passes: (p) => /\d/.test(p) },
  {
    id: 'match',
    label: 'Passwords match',
    passes: (p, c) => p.length > 0 && p === c,
  },
];

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') || '';
  const expiredParam = searchParams.get('expired') === '1';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error' | 'expired'>(
    expiredParam ? 'expired' : 'idle',
  );
  const [errorMsg, setErrorMsg] = useState('');

  const rulesPassing = useMemo(
    () => RULES.map((r) => r.passes(password, confirm)),
    [password, confirm],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    if (!token) {
      setState('error');
      setErrorMsg('This link is missing a token. Request a new reset email.');
      return;
    }
    // Per Flag #3: enforce only the two server-backed rules. Uppercase
    // + number remain advisory (Better Auth's policy controls the
    // server side; we don't want to ship a green ✓ for client rules
    // that the API might still reject).
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
      const e = err as { message?: string; status?: number };
      // Better Auth returns 400 with a message when the token is
      // invalid/expired. Surface the expired UX when the server hints
      // at expiry; otherwise inline-error.
      const msg = e.message || '';
      if (/expir|stale|already used/i.test(msg)) {
        setState('expired');
        return;
      }
      setState('error');
      setErrorMsg(
        msg ||
          'Could not reset password. The link may have expired. Request a new one.',
      );
    }
  }

  // Missing token: skip the form entirely and point the user back.
  if (!token) {
    return (
      <PageShell title="Reset your password · Floom" noIndex>
        <AuthCard dataTestId="reset-password-invalid">
          <h1 style={authH1Style}>Link invalid</h1>
          <p style={authSubStyle}>
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
          <p
            style={{
              textAlign: 'center',
              margin: '24px 0 0',
              fontSize: 13,
              color: 'var(--muted)',
            }}
          >
            <Link
              to="/login"
              style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
            >
              Back to sign in
            </Link>
          </p>
        </AuthCard>
      </PageShell>
    );
  }

  // Expired-token state — surfaces from `?expired=1` OR from a
  // server response that mentions expiry. Matches wireframe v23 E9.
  if (state === 'expired') {
    return (
      <PageShell title="Reset your password · Floom" noIndex>
        <AuthCard dataTestId="reset-password-expired">
          <h1 style={authH1Style}>Link expired.</h1>
          <p style={authSubStyle}>
            Reset links are valid for 15 minutes. Request a new one to continue.
          </p>
          <div
            data-testid="reset-password-expired-body"
            style={{
              padding: '14px 16px',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 12,
              fontSize: 12.5,
              color: '#991b1b',
              marginBottom: 18,
              lineHeight: 1.55,
            }}
          >
            This reset link expired or was already used. For your security we don&rsquo;t accept stale tokens.
          </div>
          <Link
            to="/forgot-password"
            data-testid="reset-password-resend-link"
            style={{
              ...authPrimaryButtonStyle,
              display: 'block',
              textAlign: 'center',
              textDecoration: 'none',
              marginTop: 0,
            }}
          >
            Send a new reset link
          </Link>
          <p
            style={{
              textAlign: 'center',
              margin: '24px 0 0',
              fontSize: 13,
              color: 'var(--muted)',
            }}
          >
            <Link
              to="/login"
              style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
            >
              Back to sign in
            </Link>
          </p>
        </AuthCard>
      </PageShell>
    );
  }

  return (
    <PageShell title="Reset your password · Floom" noIndex>
      <AuthCard dataTestId="reset-password-page">
        <h1 style={authH1Style}>Set a new password.</h1>
        <p style={authSubStyle}>
          {state === 'done'
            ? 'Password updated. Taking you to sign in…'
            : "Make it strong — you'll use it to sign in across web, CLI, and agent flows."}
        </p>

        {state !== 'done' && (
          <form onSubmit={handleSubmit} data-testid="reset-password-form">
            <label htmlFor="reset-new" style={authLabelStyle}>
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
              style={authInputStyle}
            />
            <label htmlFor="reset-confirm" style={authLabelStyle}>
              Confirm
            </label>
            <input
              id="reset-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="Type it again"
              data-testid="reset-password-confirm"
              style={authInputStyle}
            />

            {/* Live password rules. Visual hints only — submit blocks
                only on length + match (server enforces the rest). */}
            <div
              data-testid="reset-password-rules"
              style={{
                fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)',
                fontSize: 11,
                color: 'var(--muted)',
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: '10px 12px',
                marginTop: 8,
                lineHeight: 1.55,
              }}
            >
              {RULES.map((rule, i) => {
                const ok = rulesPassing[i];
                return (
                  <div
                    key={rule.id}
                    data-testid={`reset-password-rule-${rule.id}`}
                    data-state={ok ? 'ok' : 'pending'}
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <span
                      className={ok ? 'ok' : 'pending'}
                      style={{
                        color: ok ? 'var(--accent)' : 'var(--muted)',
                        opacity: ok ? 1 : 0.55,
                        width: 12,
                        display: 'inline-block',
                        textAlign: 'center',
                        fontWeight: 700,
                      }}
                      aria-hidden="true"
                    >
                      {ok ? '✓' : '·'}
                    </span>
                    <span>{rule.label}</span>
                  </div>
                );
              })}
            </div>

            {state === 'error' && (
              <div
                data-testid="reset-password-error"
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
                {errorMsg}
              </div>
            )}
            <button
              type="submit"
              disabled={state === 'submitting'}
              data-testid="reset-password-submit"
              style={{
                ...authPrimaryButtonStyle,
                marginTop: 18,
                opacity: state === 'submitting' ? 0.7 : 1,
                cursor: state === 'submitting' ? 'not-allowed' : 'pointer',
              }}
            >
              {state === 'submitting' ? 'Updating...' : 'Set new password'}
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

        <p
          style={{
            textAlign: 'center',
            margin: '24px 0 0',
            fontSize: 13,
            color: 'var(--muted)',
          }}
        >
          <Link
            to="/login"
            data-testid="reset-password-signin-link"
            style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
          >
            Back to sign in
          </Link>
        </p>
      </AuthCard>
    </PageShell>
  );
}
