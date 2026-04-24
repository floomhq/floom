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

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { useSession, refreshSession } from '../hooks/useSession';
import * as api from '../api/client';
import {
  friendlyAuthError,
  type AuthErrorCopy,
  type AuthErrorAction,
} from '../lib/authErrors';
import { track, identifyFromSession } from '../lib/posthog';
import { readDeployEnabled } from '../lib/flags';

type Mode = 'signin' | 'signup';

const PENDING_KEY = 'floom:pending-publish';

export function LoginPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data, isAuthenticated } = useSession();
  const deployEnabled = useMemo(() => readDeployEnabled(), []);
  const routeMode = getModeFromLocation(location.pathname, searchParams);
  const [mode, setMode] = useState<Mode>(routeMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [errorCopy, setErrorCopy] = useState<AuthErrorCopy | null>(null);
  const [noticeCopy, setNoticeCopy] = useState<AuthErrorCopy | null>(null);
  const oauthErrorParam = searchParams.get('error');

  const [hasSavedDraft, setHasSavedDraft] = useState(false);

  useEffect(() => {
    if (oauthErrorParam) {
      setState('error');
      if (oauthErrorParam === 'access_denied') {
        setErrorCopy({
          message: "Sign-in was cancelled. Try again whenever you're ready.",
        });
      } else {
        setErrorCopy({
          message: `Sign-in failed (${oauthErrorParam}). Please try again.`,
        });
      }
    }
  }, [oauthErrorParam]);
  const rawNext = searchParams.get('next');
  const safeNext =
    rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')
      ? rawNext
      : null;
  const nextPath = safeNext || (mode === 'signup' ? '/studio/build' : '/me');

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
  // server reports the provider is configured. `signInWithSocial` POSTs
  // to Better Auth, reads the provider consent URL + state cookie, then
  // top-level-navigates so the redirect chain carries the cookie back to
  // /auth/callback/<provider>. GET on /auth/sign-in/social returns 404
  // (POST-only endpoint) — that was the 2026-04-21 launch bug.
  async function signInWithProvider(provider: 'github' | 'google') {
    try {
      await api.signInWithSocial(provider, nextPath);
    } catch (err) {
      setState('error');
      setErrorCopy(friendlyAuthError(err as api.ApiError, 'signin'));
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState('submitting');
    setErrorCopy(null);
    setNoticeCopy(null);
    try {
      let session = null;
      if (mode === 'signin') {
        await api.signInWithPassword(email, password);
        session = await refreshSession();
        if (!session || session.user.is_local) {
          throw new api.ApiError('Failed to establish a session', 500, 'session_missing');
        }
        identifyFromSession(session);
        track('signin_completed');
        navigate(nextPath, { replace: true });
        return;
      } else {
        await api.signUpWithPassword(email, password, name || undefined, nextPath);
        session = await refreshSession();
        if (session && !session.user.is_local) {
          identifyFromSession(session);
          track('signup_completed');
          navigate(nextPath, { replace: true });
          return;
        }
        setMode('signin');
        setPassword('');
        setState('idle');
        setNoticeCopy({
          message: 'Check your email — the verification link will sign you in.',
          action: {
            label: 'Resend link',
            intent: { kind: 'resend-verification' },
          },
        });
        return;
      }
    } catch (err) {
      setState('error');
      setNoticeCopy(null);
      setErrorCopy(friendlyAuthError(err as api.ApiError, mode));
    }
  }

  // Wire error-recovery CTAs (e.g. "Sign in instead" after a duplicate
  // signup attempt) to real UI behavior. Keeps the email the user already
  // typed so they don't re-enter it on the other tab.
  async function handleErrorAction(action: AuthErrorAction) {
    if (action.kind === 'switch-to-signin') {
      setMode('signin');
      setErrorCopy(null);
      setNoticeCopy(null);
      setPassword('');
      setState('idle');
      return;
    }
    if (action.kind === 'switch-to-signup') {
      setMode('signup');
      setErrorCopy(null);
      setNoticeCopy(null);
      setPassword('');
      setState('idle');
      return;
    }
    if (action.kind === 'resend-verification') {
      const targetEmail = email.trim();
      if (!targetEmail) {
        setState('error');
        setErrorCopy({ message: 'Enter your email address first.' });
        return;
      }
      setState('submitting');
      setErrorCopy(null);
      try {
        await api.sendVerificationEmail(targetEmail, nextPath);
        setState('idle');
        setNoticeCopy({ message: 'We sent another verification link.' });
      } catch (err) {
        setState('error');
        setNoticeCopy(null);
        setErrorCopy(friendlyAuthError(err as api.ApiError, 'signin'));
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
        {/* 2026-04-20 (round 2): dropped the page-level hero logo. The
            TopBar above this column already renders the floom mark, so
            rendering another 56px glow mark here stacked two logos on
            top of each other and looked redundant. The right-column
            value-pitch block (below) keeps its small brand mark since
            it's a separate visual unit. */}
        {/* v17 parity 2026-04-24: display-font hero (Inter 800 tight-tracked
            per wireframe.css --font-display decision — the wireframes.floom.dev
            site still renders DM Serif Display but that font was dropped in
            the 2026-04-24 audit). Copy follows wireframes/v17/login.html:
            "Sign in to Floom" + "One account. Run apps, ship apps, all in
            one place." — same message on signup tab, the wireframe notes
            call out this is intentionally one combined page.
            #545 regression fix 2026-04-23: bumped weight 700 → 800 and
            letter-spacing -0.02em → -0.025em to match the display-font
            spec. Previous values rendered as plain Inter 700 once the
            display token was applied. */}
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: '-0.025em',
            lineHeight: 1.15,
            margin: '0 0 8px',
            color: 'var(--ink)',
            textAlign: 'center',
          }}
        >
          {mode === 'signin' ? 'Sign in to Floom' : 'Create your Floom account'}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 24px', textAlign: 'center' }}>
          {mode === 'signin'
            ? 'One account. Run apps, ship apps, all in one place.'
            : deployEnabled
              ? 'One account. Run apps, connect tools, publish your own.'
              : 'One account. Run apps, save history, and manage runs.'}
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

        {noticeCopy && (
          <div
            data-testid="auth-notice"
            style={{
              margin: '0 0 12px',
              padding: '10px 12px',
              background: '#ecfdf5',
              border: '1px solid #b7ebd3',
              borderRadius: 8,
              fontSize: 13,
              color: '#0f5132',
              lineHeight: 1.5,
            }}
          >
            <div>{noticeCopy.message}</div>
            {noticeCopy.action && (
              <button
                type="button"
                data-testid="auth-notice-action"
                onClick={() => void handleErrorAction(noticeCopy.action!.intent)}
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
                {noticeCopy.action.label}
              </button>
            )}
          </div>
        )}

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

        {/* #633 2026-04-23: removed the BYOK callout that used to live
            here. The auth screen is not the place to ask users to think
            about API keys — it just adds friction before they've even
            signed in. BYOK setup stays in /me/settings and the
            rate-limit modal (5 free runs → "add your key to continue"),
            which is where the prompt is actually contextual. */}

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
              <Link
                to="/forgot-password"
                data-testid="forgot-password-link"
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  textDecoration: 'underline',
                }}
              >
                Forgot password?
              </Link>
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
                  onClick={() => void handleErrorAction(errorCopy.action!.intent)}
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
          auth page, so we dropped it (2026-04-20).
          2026-04-21: dropped the standalone brand mark from this panel.
          The TopBar already renders the floom logo in the chrome, so
          showing another one here read as double-branding. Stripe /
          Linear / Notion put one mark in the chrome and zero in the
          side panel. */}
      <aside
        className="login-right"
        data-testid="login-value-pitch"
        style={{
          padding: '8px 0 0',
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1.3,
            margin: '0 0 12px',
            color: 'var(--ink)',
          }}
        >
          {deployEnabled ? 'Ship AI apps fast.' : 'Run AI apps from one account.'}
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--muted)',
            lineHeight: 1.6,
            margin: 0,
          }}
        >
          {deployEnabled ? (
            <>Paste a GitHub link. Get a runnable app in 30 seconds.</>
          ) : (
            <>
              Try catalog apps, MCP, and your dashboard on floom.dev. Publishing to
              our cloud is waitlist-only; self-host stays unrestricted.
            </>
          )}
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

// #563 2026-04-23: font-size is 16px, not 14px. iOS Safari auto-zooms
// into any input whose computed font-size is < 16px on focus, which
// jolts the viewport on mobile sign-in. 16px is the documented fix
// (WebKit zoom trigger is < 16px) and matches what Stripe / Linear /
// Vercel ship on their auth surfaces. Applied at all breakpoints —
// there's no visual downside on desktop.
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  fontSize: 16,
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
  transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
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
