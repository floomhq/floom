// W4-minimal: combined /login + /signup page.
//
// Two modes switched by a tab at the top: "Sign in" and "Create account".
// Each mode supports email+password, magic link, and Google OAuth.
//
// In OSS mode Better Auth is not mounted, so the /auth/* POSTs will 404.
// We detect that via /api/session/me (cloud_mode: false) and render a
// banner letting the user know they can use the local account.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { useSession, refreshSession } from '../hooks/useSession';
import * as api from '../api/client';

type Mode = 'signin' | 'signup';

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data, isAuthenticated } = useSession();
  const initialMode: Mode = searchParams.get('mode') === 'signup' ? 'signup' : 'signin';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'magic-sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const nextPath = searchParams.get('next') || '/me';

  // If the user is already logged in (cloud mode) redirect away.
  useEffect(() => {
    if (isAuthenticated) {
      navigate(nextPath, { replace: true });
    }
  }, [isAuthenticated, navigate, nextPath]);

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState('submitting');
    setErrorMsg('');
    try {
      if (mode === 'signin') {
        await api.signInWithPassword(email, password);
      } else {
        await api.signUpWithPassword(email, password, name || undefined);
      }
      await refreshSession();
      navigate(nextPath, { replace: true });
    } catch (err) {
      setState('error');
      const e = err as api.ApiError;
      if (e.status === 404) {
        setErrorMsg(
          'Cloud auth is not enabled on this server. Run with FLOOM_CLOUD_MODE=true or use the local dev user.',
        );
      } else if (e.status === 401) {
        setErrorMsg('Wrong email or password.');
      } else if (e.status === 422 || e.status === 400) {
        setErrorMsg(e.message || 'Email or password invalid.');
      } else {
        setErrorMsg(e.message || 'Sign-in failed.');
      }
    }
  }

  async function handleMagicLink() {
    if (!email) {
      setErrorMsg('Enter your email first.');
      setState('error');
      return;
    }
    setState('submitting');
    setErrorMsg('');
    try {
      await api.sendMagicLink(email, nextPath);
      setState('magic-sent');
    } catch (err) {
      setState('error');
      const e = err as api.ApiError;
      if (e.status === 404) {
        setErrorMsg('Cloud auth is not enabled on this server.');
      } else {
        setErrorMsg(e.message || 'Could not send magic link.');
      }
    }
  }

  function handleSocial(provider: 'google' | 'github') {
    window.location.href = api.socialSignInUrl(provider, nextPath);
  }

  const cloudMode = data?.cloud_mode === true;

  return (
    <PageShell title={mode === 'signin' ? 'Sign in | Floom' : 'Create account | Floom'}>
      <div
        style={{
          maxWidth: 440,
          margin: '40px auto',
        }}
        data-testid={mode === 'signin' ? 'login-page' : 'signup-page'}
      >
        <h1
          style={{
            fontSize: 28,
            fontWeight: 700,
            margin: '0 0 8px',
            color: 'var(--ink)',
          }}
        >
          {mode === 'signin' ? 'Sign in to Floom' : 'Create your Floom account'}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 24px' }}>
          {mode === 'signin'
            ? 'Sign in with email and password, a magic link, or Google.'
            : 'One account. Run apps, connect tools, publish your own.'}
        </p>

        {/* Tabs */}
        <div
          role="tablist"
          style={{
            display: 'flex',
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: 4,
            marginBottom: 24,
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signin'}
            onClick={() => setMode('signin')}
            data-testid="tab-signin"
            style={tabStyle(mode === 'signin')}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            onClick={() => setMode('signup')}
            data-testid="tab-signup"
            style={tabStyle(mode === 'signup')}
          >
            Create account
          </button>
        </div>

        {!cloudMode && (
          <div
            data-testid="cloud-disabled-banner"
            style={{
              background: '#fff8e6',
              border: '1px solid #f4e0a5',
              color: '#755a00',
              borderRadius: 8,
              padding: '12px 14px',
              fontSize: 13,
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            This server runs in OSS mode. Cloud auth endpoints are not mounted;
            you can still browse and run apps as the local user.{' '}
            <Link to={nextPath} style={{ color: 'var(--accent)', fontWeight: 600 }}>
              Continue as local
            </Link>
          </div>
        )}

        {/* Social providers */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => handleSocial('google')}
            data-testid="oauth-google"
            style={socialButtonStyle}
          >
            <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.19 3.32v2.77h3.54c2.08-1.91 3.29-4.74 3.29-8.1z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.54-2.77c-.98.66-2.24 1.05-3.74 1.05-2.88 0-5.31-1.94-6.18-4.55H2.17v2.87A11 11 0 0 0 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.82 14.07a6.6 6.6 0 0 1 0-4.14V7.06H2.17a11 11 0 0 0 0 9.88l3.65-2.87z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.07.56 4.21 1.64l3.15-3.15C17.45 2.1 14.97 1 12 1 7.7 1 3.99 3.47 2.17 7.06l3.65 2.87C6.69 7.32 9.12 5.38 12 5.38z"
              />
            </svg>
            Continue with Google
          </button>
          <button
            type="button"
            onClick={() => handleSocial('github')}
            data-testid="oauth-github"
            style={socialButtonStyle}
          >
            <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2 0 1.9 1.3 1.9 1.3 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.4.8-1.7-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.3-3.2-.2-.3-.6-1.6.1-3.3 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.3 3 .1 3.3.8.8 1.3 1.9 1.3 3.2 0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.3v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3z" />
            </svg>
            Continue with GitHub
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            margin: '16px 0',
            color: 'var(--muted)',
            fontSize: 12,
          }}
        >
          <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
          or
          <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
        </div>

        <form onSubmit={handlePasswordSubmit}>
          {mode === 'signup' && (
            <>
              <label style={labelStyle}>Display name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Lovelace"
                data-testid="input-name"
                style={inputStyle}
                autoComplete="name"
              />
            </>
          )}
          <label style={labelStyle}>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="you@example.com"
            data-testid="input-email"
            style={inputStyle}
            autoComplete="email"
          />
          <label style={labelStyle}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            placeholder="At least 8 characters"
            data-testid="input-password"
            style={inputStyle}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />

          {state === 'error' && (
            <p
              data-testid="auth-error"
              style={{
                margin: '0 0 12px',
                fontSize: 13,
                color: '#c2791c',
              }}
            >
              {errorMsg}
            </p>
          )}
          {state === 'magic-sent' && (
            <p
              data-testid="magic-sent"
              style={{
                margin: '0 0 12px',
                fontSize: 13,
                color: 'var(--success, #1a7f37)',
              }}
            >
              Magic link sent. Check your inbox at {email}.
            </p>
          )}

          <button
            type="submit"
            disabled={state === 'submitting'}
            data-testid="submit-password"
            style={{
              ...primaryButtonStyle,
              opacity: state === 'submitting' ? 0.7 : 1,
              cursor: state === 'submitting' ? 'not-allowed' : 'pointer',
            }}
          >
            {state === 'submitting'
              ? 'Working...'
              : mode === 'signin'
              ? 'Sign in'
              : 'Create account'}
          </button>
          <button
            type="button"
            onClick={handleMagicLink}
            data-testid="submit-magic"
            style={{
              ...secondaryButtonStyle,
              marginTop: 8,
            }}
          >
            Send magic link instead
          </button>
        </form>

        <p
          style={{
            textAlign: 'center',
            margin: '24px 0 0',
            fontSize: 13,
            color: 'var(--muted)',
          }}
        >
          {mode === 'signin' ? "Don't have an account? " : 'Already have one? '}
          <button
            type="button"
            onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
              font: 'inherit',
            }}
          >
            {mode === 'signin' ? 'Create account' : 'Sign in'}
          </button>
        </p>
      </div>
    </PageShell>
  );
}

const tabStyle = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '8px 12px',
  background: active ? 'var(--card)' : 'transparent',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: active ? 600 : 500,
  color: active ? 'var(--ink)' : 'var(--muted)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  boxShadow: active ? '0 1px 2px rgba(0,0,0,0.04)' : 'none',
});

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
  background: 'var(--ink)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
  marginTop: 12,
};

const secondaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '11px 16px',
  background: 'transparent',
  color: 'var(--muted)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const socialButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  padding: '11px 14px',
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--ink)',
  fontFamily: 'inherit',
  cursor: 'pointer',
};
