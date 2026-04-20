// W4-minimal: combined /login + /signup page.
//
// Two modes switched by a tab at the top: "Sign in" and "Create account".
// Each mode supports email+password only. Google/GitHub OAuth buttons were
// removed 2026-04-17 pre-launch because the OAuth apps were not configured
// on preview/prod; dead buttons are a trust-killer. Re-enable with a follow-up
// PR that also registers the OAuth clients and sets
// GOOGLE_OAUTH_CLIENT_ID/SECRET + GITHUB_OAUTH_CLIENT_ID/SECRET env vars.
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
  const [errorMsg, setErrorMsg] = useState('');
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

  // OAuth social sign-in (Google/GitHub) was removed 2026-04-17. The buttons
  // pointed at /auth/sign-in/social but Better Auth only registers a provider
  // when both CLIENT_ID and CLIENT_SECRET are set, and we hadn't created the
  // OAuth apps. Keep `socialSignInUrl` in the api client for when we bring it
  // back.

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
        {/* Brand mark on the auth hero. Glow + boot-in fade on mount
            makes the page feel intentional rather than springing into
            existence as a form. Boot-in is a one-shot so it doesn't
            re-animate while the user switches sign-in / create-account
            tabs. */}
        <div
          data-testid="login-logo"
          style={{
            display: 'flex',
            justifyContent: 'center',
            marginBottom: 20,
          }}
        >
          <Logo size={56} variant="glow" animate="boot-in" />
        </div>
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

        {/* Google/GitHub OAuth buttons removed 2026-04-17 pre-launch. See
            comment at top of file. */}

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

      {/* Right column: value pitch. Hidden on mobile via CSS (<1024px). */}
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
            marginBottom: 20,
          }}
        >
          <Logo size={32} variant="glow" />
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>floom</div>
        </div>
        <h2
          style={{
            fontSize: 20,
            fontWeight: 700,
            lineHeight: 1.3,
            margin: '0 0 16px',
            color: 'var(--ink)',
          }}
        >
          Production infrastructure for AI apps that do real work.
        </h2>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '0 0 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <ValueBullet
            title="Ship AI apps in 30 seconds, not weeks."
            desc="Paste your app's link. Get a Claude tool, a page to share, a CLI, and a URL your teammates can hit."
          />
          <ValueBullet
            title="Free to run yourself. Cloud for the creator tools."
            desc="The open-source version is yours forever. Cloud adds longer-running jobs, live updates, and managed sign-in keys."
          />
          <ValueBullet
            title="One app. Five ways to use it."
            desc="Same app runs in Claude, ChatGPT, Notion, your terminal, and the Store. No glue code."
          />
        </ul>
        <div
          style={{
            fontSize: 12,
            color: 'var(--muted)',
            padding: '12px 14px',
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 10,
          }}
        >
          Built for creators who want their apps run by agents, not polished into dashboards.
        </div>
      </aside>
      </div>
    </PageShell>
  );
}

function ValueBullet({ title, desc }: { title: string; desc: string }) {
  return (
    <li
      className="value-bullet"
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '12px 14px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 10,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          width: 18,
          height: 18,
          borderRadius: 9,
          background: 'var(--accent)',
          color: '#fff',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          fontSize: 11,
          fontWeight: 700,
          marginTop: 2,
        }}
      >
        ✓
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 2 }}>
          {title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{desc}</div>
      </div>
    </li>
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
