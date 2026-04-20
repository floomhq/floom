// W4-minimal: combined /login + /signup page.
//
// Two modes switched by a tab at the top: "Sign in" and "Create account".
// Supports email+password AND Google/GitHub OAuth. Social buttons render
// only when the server reports the provider is configured (see
// /api/session/me -> auth_providers.{google,github}). A provider is
// "configured" iff both its OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET env
// vars are set on the server (apps/server/src/lib/better-auth.ts reads
// them lazily; workspaces.ts `me()` echoes the flags). This lets ops flip
// OAuth on/off per environment without a rebuild.
//
// In OSS mode Better Auth is not mounted, so the /auth/* POSTs will 404.
// We detect that via /api/session/me (cloud_mode: false) and render a
// banner letting the user know they can use the local account.

import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { Logo } from '../components/Logo';
import { useSession, refreshSession } from '../hooks/useSession';
import * as api from '../api/client';
import {
  friendlyAuthError,
  type AuthErrorCopy,
  type AuthErrorAction,
} from '../lib/authErrors';

type Mode = 'signin' | 'signup';

const PENDING_KEY = 'floom:pending-publish';

export function LoginPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data, isAuthenticated } = useSession();
  const routeMode = getModeFromLocation(location.pathname, searchParams);
  const [mode, setMode] = useState<Mode>(routeMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [errorCopy, setErrorCopy] = useState<AuthErrorCopy | null>(null);
  const [hasSavedDraft, setHasSavedDraft] = useState(false);

  const nextPath = searchParams.get('next') || '/me';

  // If the user is already logged in (cloud mode) redirect away.
  useEffect(() => {
    if (isAuthenticated) {
      navigate(nextPath, { replace: true });
    }
  }, [isAuthenticated, navigate, nextPath]);

  useEffect(() => {
    setMode(routeMode);
  }, [routeMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const savedDraft = window.localStorage.getItem(PENDING_KEY);
      setHasSavedDraft(Boolean(savedDraft) && nextPath.startsWith('/studio/build'));
    } catch {
      setHasSavedDraft(false);
    }
  }, [nextPath]);

  // OAuth social sign-in (Google/GitHub). Buttons render only when the
  // server reports the provider is configured. Fires a top-level navigation
  // to the Better Auth social endpoint; the redirect chain ends back at
  // /me (or `nextPath`) with the session cookie set.
  function signInWithProvider(provider: 'github' | 'google') {
    const url = api.socialSignInUrl(provider, nextPath);
    window.location.assign(url);
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState('submitting');
    setErrorCopy(null);
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
      setErrorCopy(friendlyAuthError(err as api.ApiError, mode));
    }
  }

  // Wire error-recovery CTAs (e.g. "Sign in instead" after a duplicate
  // signup attempt) to real UI behavior. Keeps the email the user already
  // typed so they don't re-enter it on the other tab.
  function handleErrorAction(action: AuthErrorAction) {
    if (action.kind === 'switch-to-signin') {
      setMode('signin');
      setErrorCopy(null);
      setPassword('');
      setState('idle');
      return;
    }
    if (action.kind === 'switch-to-signup') {
      setMode('signup');
      setErrorCopy(null);
      setPassword('');
      setState('idle');
      return;
    }
    if (action.kind === 'resend-verification') {
      // No dedicated resend endpoint on the client yet; send the user to
      // the support mailer as a graceful fallback. When Better Auth's
      // email-verification plugin lands we can hit it directly.
      window.location.href =
        'mailto:team@floom.dev?subject=' +
        encodeURIComponent('Resend Floom verification email') +
        '&body=' +
        encodeURIComponent(`Please resend verification for ${email}.`);
    }
  }

  const cloudMode = data?.cloud_mode === true;

  return (
    <PageShell title={mode === 'signin' ? 'Sign in · Floom' : 'Create account · Floom'}>
      <div
        className="login-grid"
        style={{
          display: 'grid',
          gap: 48,
          gridTemplateColumns: '440px 1fr',
          maxWidth: 960,
          margin: '40px auto',
          alignItems: 'start',
        }}
      >
      <div
        className="login-left"
        style={{
          width: '100%',
          maxWidth: 440,
        }}
        data-testid={mode === 'signin' ? 'login-page' : 'signup-page'}
      >
        {/* 2026-04-20 (round 2): dropped the page-level hero logo. The
            TopBar above this column already renders the floom mark, so
            rendering another 56px glow mark here stacked two logos on
            top of each other and looked redundant. The right-column
            value-pitch block (below) keeps its small brand mark since
            it's a separate visual unit. */}
        <h1
          style={{
            fontSize: 28,
            fontWeight: 700,
            margin: '0 0 8px',
            color: 'var(--ink)',
            textAlign: 'center',
          }}
        >
          {mode === 'signin' ? 'Welcome to Floom' : 'Create your Floom account'}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 24px', textAlign: 'center' }}>
          {mode === 'signin'
            ? 'Use your email and password.'
            : 'One account. Run apps, connect tools, publish your own.'}
        </p>

        {hasSavedDraft && (
          <div
            data-testid="auth-resume-banner"
            style={{
              background: '#ecfdf5',
              border: '1px solid #b7ebd3',
              color: '#0f5132',
              borderRadius: 10,
              padding: '12px 14px',
              fontSize: 13,
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            Your app draft is saved. {mode === 'signin' ? 'Sign in' : 'Create your account'} to pick up where you left off.
          </div>
        )}

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
            This server is running in open-source mode. Sign-in with an account is off
            here, but you can still browse and run apps as the local user.{' '}
            <Link to={nextPath} style={{ color: 'var(--accent)', fontWeight: 600 }}>
              Continue as local
            </Link>
          </div>
        )}

        {/* Social sign-in (OAuth). Buttons render only when the provider
            is configured on this server — dead buttons are a trust-killer.
            Check: data.auth_providers.{google,github}. */}
        {cloudMode && (data?.auth_providers?.google || data?.auth_providers?.github) && (
          <>
            <div
              data-testid="oauth-buttons"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                marginBottom: 16,
              }}
            >
              {data?.auth_providers?.github && (
                <button
                  type="button"
                  onClick={() => signInWithProvider('github')}
                  data-testid="oauth-github"
                  style={oauthButtonStyle}
                >
                  <GitHubIcon />
                  <span>Continue with GitHub</span>
                </button>
              )}
              {data?.auth_providers?.google && (
                <button
                  type="button"
                  onClick={() => signInWithProvider('google')}
                  data-testid="oauth-google"
                  style={oauthButtonStyle}
                >
                  <GoogleIcon />
                  <span>Continue with Google</span>
                </button>
              )}
            </div>
            <div
              data-testid="oauth-divider"
              aria-hidden="true"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                margin: '0 0 16px',
                color: 'var(--muted)',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
              <span>or continue with email</span>
              <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            </div>
          </>
        )}

        <form onSubmit={handlePasswordSubmit}>
          {mode === 'signup' && (
            <>
              <label htmlFor="login-name" style={labelStyle}>Display name</label>
              <input
                id="login-name"
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
          <label htmlFor="login-email" style={labelStyle}>Email</label>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="you@example.com"
            data-testid="input-email"
            style={inputStyle}
            autoComplete="email"
          />
          <label htmlFor="login-password" style={labelStyle}>Password</label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
            data-testid="input-password"
            style={inputStyle}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />

          {mode === 'signin' && (
            <div style={{ textAlign: 'right', margin: '-2px 0 12px' }}>
              <a
                href="mailto:team@floom.dev?subject=Password%20reset"
                data-testid="forgot-password-link"
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  textDecoration: 'underline',
                }}
              >
                Forgot password?
              </a>
            </div>
          )}

          {state === 'error' && errorCopy && (
            <div
              data-testid="auth-error"
              style={{
                margin: '0 0 12px',
                padding: '10px 12px',
                background: '#fff8e6',
                border: '1px solid #f4e0a5',
                borderRadius: 8,
                fontSize: 13,
                color: '#8a5a00',
                lineHeight: 1.5,
              }}
            >
              <div>{errorCopy.message}</div>
              {errorCopy.action && (
                <button
                  type="button"
                  data-testid="auth-error-action"
                  onClick={() => handleErrorAction(errorCopy.action!.intent)}
                  style={{
                    marginTop: 6,
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent)',
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                    padding: 0,
                    textDecoration: 'underline',
                    fontFamily: 'inherit',
                  }}
                >
                  {errorCopy.action.label}
                </button>
              )}
            </div>
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

      {/* Right column: value pitch. Hidden on mobile via CSS (<1024px).
          Kept intentionally quiet: one headline + one supporting line.
          The three-bullet + closing-line version read as filler on an
          auth page, so we dropped it (2026-04-20). */}
      <aside
        className="login-right"
        data-testid="login-value-pitch"
        style={{
          padding: '8px 0 0',
        }}
      >
        <div
          data-testid="login-right-logo"
          data-glow="true"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 24,
          }}
        >
          <Logo size={32} variant="glow" />
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>floom</div>
        </div>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 700,
            lineHeight: 1.3,
            margin: '0 0 12px',
            color: 'var(--ink)',
          }}
        >
          Ship AI apps fast.
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--muted)',
            lineHeight: 1.6,
            margin: 0,
          }}
        >
          Paste a GitHub link. Get a runnable app in 30 seconds.
        </p>
      </aside>
      </div>
    </PageShell>
  );
}

function getModeFromLocation(pathname: string, searchParams: URLSearchParams): Mode {
  if (searchParams.get('mode') === 'signup') return 'signup';
  if (pathname === '/signup') return 'signup';
  return 'signin';
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

// Goosebumps pass 2026-04-20: auth primary CTAs (Sign in / Create account)
// are brand green, matching the nav "Publish an app" + hero "Publish your
// app" submit button. One primary action per view, same color system.
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

// Full-width, outlined, white-bg button matching the login-page surface.
// Neutral styling so GitHub and Google sit side-by-side without one looking
// more prominent than the other. Brand-specific color would push a
// provider preference, which we don't want to signal.
const oauthButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  width: '100%',
  padding: '11px 16px',
  background: 'var(--card)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

// Real brand logos (SimpleIcons-licensed SVG paths). No text-in-circles
// monograms — those read as AI-slop on an auth page.
function GitHubIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
