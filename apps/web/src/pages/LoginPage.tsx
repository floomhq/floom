// W4-minimal: combined /login + /signup page.
//
// v23 PR-F (decision doc /tmp/wireframe-react/auth-decision.md):
//   - Single centred card via <AuthCard>; right-column "value pitch"
//     and the legacy `Sign in / Sign up` top tabs are gone (B5/B6/C2).
//   - Heading + subhead + footer link + primary CTA label switch on
//     `mode` so /login and /signup feel like distinct pages even
//     though they share this component (B1/B2/B11/C1/C3, B7/C11).
//   - /signup gets a 2-button intent toggle (`run` vs `publish`). The
//     `?mode=publish` URL param pre-selects publish (B3/B4). After
//     auth, intent steers `nextPath`: `publish` → /studio/build,
//     `run` → /me.
//   - OAuth tiles get the v23 padding (13/16) + left alignment, plus a
//     mono-uppercase "or" divider before the password form (A15/A16).
//   - Login submit gets a `<kbd>⌘ ↵</kbd>` (or `Ctrl ↵`) hint inside
//     the button, OS-detected (C7).
//   - Saved-draft pill: ABOVE OAuth on mobile, BELOW submit on desktop
//     (C9/C10). Slug + relative time read from localStorage if
//     present; else falls back to a generic line.
//   - Display-name field on signup is dropped (B9 default — matches
//     wireframe; better-auth captures display name later).
//
// Auth mechanics (unchanged):
//   - Two modes switched by `mode` derived from the route (and the
//     legacy `?mode=signup` alias).
//   - Supports email+password AND Google/GitHub OAuth. Social buttons
//     render only when the server reports the provider is configured
//     (see /api/session/me -> auth_providers.{google,github}).
//   - In OSS mode Better Auth is not mounted, so the /auth/* POSTs
//     would 404. We detect that via /api/session/me (cloud_mode: false)
//     and render a banner letting the user know they can use the
//     local account.

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import {
  AuthCard,
  AuthOrDivider,
  authH1Style,
  authSubStyle,
  authLabelStyle,
  authInputStyle,
  authPrimaryButtonStyle,
  authOAuthButtonStyle,
} from '../components/auth/AuthCard';
import { useSession, refreshSession } from '../hooks/useSession';
import * as api from '../api/client';
import {
  friendlyAuthError,
  type AuthErrorCopy,
  type AuthErrorAction,
} from '../lib/authErrors';
import { track, identifyFromSession } from '../lib/posthog';

type Mode = 'signin' | 'signup';
type Intent = 'run' | 'publish';

const PENDING_KEY = 'floom:pending-publish';

interface PendingDraft {
  slug?: string;
  startedAt?: number;
}

/** Read the saved-draft payload from localStorage, tolerating legacy
 *  shapes. The payload was historically a plain string flag; v23 may
 *  carry `{ slug, startedAt }`. We never fabricate fields — if the
 *  payload is just a flag, slug + startedAt are undefined. */
function readPendingDraft(): PendingDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as PendingDraft;
      return {
        slug: typeof parsed.slug === 'string' ? parsed.slug : undefined,
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : undefined,
      };
    }
    return {};
  } catch {
    return null;
  }
}

function relativeTime(ms: number | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  const diff = Date.now() - ms;
  if (diff < 0) return null;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator.platform || '').toLowerCase();
  if (platform.includes('mac')) return true;
  // Fallback for browsers reporting `userAgent` only.
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

export function LoginPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data, isAuthenticated } = useSession();
  const routeMode = getModeFromLocation(location.pathname, searchParams);
  const initialIntent = getIntentFromLocation(searchParams);
  const [mode, setMode] = useState<Mode>(routeMode);
  const [intent, setIntent] = useState<Intent>(initialIntent);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [errorCopy, setErrorCopy] = useState<AuthErrorCopy | null>(null);
  const [noticeCopy, setNoticeCopy] = useState<AuthErrorCopy | null>(null);
  const oauthErrorParam = searchParams.get('error');

  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const isMac = useMemo(() => isMacPlatform(), []);

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
  // v23: post-auth route follows intent on /signup. Sign-in defaults
  // to /me unless `next` overrides.
  const nextPath =
    safeNext ||
    (mode === 'signup'
      ? intent === 'publish'
        ? '/studio/build'
        : '/me'
      : '/me');

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
    setIntent(initialIntent);
  }, [initialIntent]);

  useEffect(() => {
    setPendingDraft(readPendingDraft());
  }, []);

  // Saved-draft pill renders only on /login when there's a pending
  // publish draft. On signup we show the mode toggle instead.
  const savedDraftRelTime = relativeTime(pendingDraft?.startedAt);
  const showSavedDraft = mode === 'signin' && pendingDraft !== null;

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
        // v23 B9: dropped display-name field. better-auth captures it later.
        await api.signUpWithPassword(email, password, undefined, nextPath);
        session = await refreshSession();
        if (session && !session.user.is_local) {
          identifyFromSession(session);
          track('signup_completed');
          navigate(nextPath, { replace: true });
          return;
        }
        // Verification email flow: surface a notice and route to /login
        // so the user knows where to land after clicking the email.
        navigate('/login', { replace: true });
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
  // signup attempt) to real UI behavior. We use route navigation so
  // the URL stays the source of truth (/login vs /signup); React state
  // syncs via the `routeMode` effect above.
  async function handleErrorAction(action: AuthErrorAction) {
    if (action.kind === 'switch-to-signin') {
      setErrorCopy(null);
      setNoticeCopy(null);
      setPassword('');
      setState('idle');
      navigate('/login', { replace: true });
      return;
    }
    if (action.kind === 'switch-to-signup') {
      setErrorCopy(null);
      setNoticeCopy(null);
      setPassword('');
      setState('idle');
      navigate('/signup', { replace: true });
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
  const hasOAuthProvider = Boolean(
    cloudMode && (data?.auth_providers?.google || data?.auth_providers?.github),
  );
  const showPasswordForm = !hasOAuthProvider;

  const cardWidth = mode === 'signup' ? 480 : 440;

  const heading =
    mode === 'signup' ? 'Create your account.' : 'Welcome back.';
  const subhead =
    mode === 'signup'
      ? '30 seconds. Free for launch.'
      : 'Sign in to publish apps, view runs, manage secrets.';
  const submitLabel =
    mode === 'signup' ? 'Create account' : 'Sign in';
  const footer =
    mode === 'signup' ? (
      <>
        Already have an account?{' '}
        <Link
          to="/login"
          data-testid="auth-footer-link"
          style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
        >
          Sign in &rarr;
        </Link>
      </>
    ) : (
      <>
        New here?{' '}
        <Link
          to="/signup"
          data-testid="auth-footer-link"
          style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
        >
          Create an account &rarr;
        </Link>
      </>
    );

  return (
    <PageShell title={mode === 'signin' ? 'Sign in · Floom' : 'Sign up · Floom'}>
      <AuthCard
        maxWidth={cardWidth}
        dataTestId={mode === 'signin' ? 'login-page' : 'signup-page'}
      >
        <h1 style={authH1Style}>{heading}</h1>
        <p style={authSubStyle}>{subhead}</p>

        {/* Mobile-first saved-draft pill: ABOVE OAuth on /login mobile.
            We render once and use CSS to position it correctly on each
            breakpoint (mobile order:above, desktop order:below). */}
        {showSavedDraft && (
          <SavedDraftPill
            slug={pendingDraft?.slug}
            relativeTime={savedDraftRelTime}
            position="mobile"
          />
        )}

        {/* /signup-only: dual-mode toggle (run vs publish). Reads
            `?mode=publish` from URL on mount; updates `intent` state
            and rewrites `nextPath` so post-auth lands on /studio/build
            for publishers, /me for runners. */}
        {mode === 'signup' && (
          <SignupModeToggle intent={intent} onChange={setIntent} />
        )}

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
        {hasOAuthProvider && (
          <div
            data-testid="oauth-buttons"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              marginBottom: 18,
            }}
          >
            {data?.auth_providers?.google && (
              <button
                type="button"
                onClick={() => signInWithProvider('google')}
                data-testid="oauth-google"
                style={authOAuthButtonStyle}
              >
                <GoogleIcon />
                <span>Continue with Google</span>
              </button>
            )}
            {data?.auth_providers?.github && (
              <button
                type="button"
                onClick={() => signInWithProvider('github')}
                data-testid="oauth-github"
                style={authOAuthButtonStyle}
              >
                <GitHubIcon />
                <span>Continue with GitHub</span>
              </button>
            )}
          </div>
        )}

        {/* OR divider — render only when both OAuth tiles AND the
            password form are visible (decision doc Risk #7). In OSS
            mode OAuth is hidden, so a lone "or" between nothing and
            the form would be visual noise. */}
        {hasOAuthProvider && showPasswordForm && <AuthOrDivider />}

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

        {showPasswordForm && (
          <form onSubmit={handlePasswordSubmit}>
            <label htmlFor="login-email" style={authLabelStyle}>Email</label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              data-testid="input-email"
              style={authInputStyle}
              autoComplete="email"
            />
            <label htmlFor="login-password" style={authLabelStyle}>Password</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
              data-testid="input-password"
              style={authInputStyle}
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

            <button
              type="submit"
              disabled={state === 'submitting'}
              data-testid="submit-password"
              style={{
                ...authPrimaryButtonStyle,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                opacity: state === 'submitting' ? 0.7 : 1,
                cursor: state === 'submitting' ? 'not-allowed' : 'pointer',
              }}
            >
              <span>
                {state === 'submitting' ? 'Working...' : submitLabel}
              </span>
              {/* Login-only: ⌘ ↵ keyboard hint. macOS shows ⌘, others
                  show Ctrl. Hidden during submitting to avoid layout
                  shift on the spinner copy. */}
              {mode === 'signin' && state !== 'submitting' && (
                <KbdHint mac={isMac} />
              )}
            </button>
          </form>
        )}

        {/* Saved-draft pill — DESKTOP position (below submit). The
            mobile copy is already rendered above, so we only paint
            this on viewports where mobile pill is hidden via CSS. */}
        {showSavedDraft && (
          <SavedDraftPill
            slug={pendingDraft?.slug}
            relativeTime={savedDraftRelTime}
            position="desktop"
          />
        )}

        {/* Signup-only: legal terms line. The wireframe prescribes a
            single sentence; we drop the older GEMINI_API_KEY paragraph
            and the "No password" reassurance line per B8 (those were
            sales copy, not auth-flow info). */}
        {mode === 'signup' && (
          <p
            style={{
              fontSize: 11.5,
              color: 'var(--muted)',
              lineHeight: 1.5,
              margin: '14px 0 0',
              textAlign: 'center',
            }}
          >
            By signing up you agree to our{' '}
            <Link to="/terms" style={{ color: 'var(--ink)' }}>Terms</Link> and{' '}
            <Link to="/privacy" style={{ color: 'var(--ink)' }}>Privacy</Link>.
          </p>
        )}
        {mode === 'signin' && !hasOAuthProvider && (
          <p
            style={{
              fontSize: 11.5,
              color: 'var(--muted)',
              lineHeight: 1.5,
              margin: '14px 0 0',
              textAlign: 'center',
            }}
          >
            By continuing, you agree to our{' '}
            <Link to="/terms" style={{ color: 'var(--ink)' }}>Terms</Link> and{' '}
            <Link to="/privacy" style={{ color: 'var(--ink)' }}>Privacy</Link>.
          </p>
        )}

        <p
          style={{
            textAlign: 'center',
            margin: '24px 0 0',
            fontSize: 13,
            color: 'var(--muted)',
          }}
          data-testid="auth-footer"
        >
          {footer}
        </p>
      </AuthCard>
    </PageShell>
  );
}

function getModeFromLocation(pathname: string, searchParams: URLSearchParams): Mode {
  if (pathname === '/signup') return 'signup';
  // Legacy alias: ?mode=signup on /login still flips into signup mode.
  if (searchParams.get('mode') === 'signup') return 'signup';
  return 'signin';
}

function getIntentFromLocation(searchParams: URLSearchParams): Intent {
  return searchParams.get('mode') === 'publish' ? 'publish' : 'run';
}

interface SignupModeToggleProps {
  intent: Intent;
  onChange: (intent: Intent) => void;
}

function SignupModeToggle({ intent, onChange }: SignupModeToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="What do you want to do?"
      data-testid="signup-mode-toggle"
      style={{
        display: 'flex',
        gap: 0,
        padding: 4,
        background: 'var(--bg)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        marginBottom: 24,
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={intent === 'run'}
        onClick={() => onChange('run')}
        data-testid="signup-mode-run"
        style={modeToggleButtonStyle(intent === 'run')}
      >
        I want to run apps
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={intent === 'publish'}
        onClick={() => onChange('publish')}
        data-testid="signup-mode-publish"
        style={modeToggleButtonStyle(intent === 'publish')}
      >
        I want to publish apps
      </button>
    </div>
  );
}

const modeToggleButtonStyle = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '8px 12px',
  border: 0,
  background: active ? 'var(--card)' : 'transparent',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: active ? 600 : 500,
  color: active ? 'var(--ink)' : 'var(--muted)',
  borderRadius: 7,
  cursor: 'pointer',
  boxShadow: active ? '0 1px 2px rgba(14,14,12,0.06)' : 'none',
  transition: 'all 0.15s ease',
});

interface SavedDraftPillProps {
  slug?: string;
  relativeTime: string | null;
  /** Two render targets so the same pill can sit ABOVE OAuth on
   *  mobile and BELOW submit on desktop. We swap visibility via inline
   *  media-query style (data-position attr + CSS in index.css would
   *  also work, but inline keeps this self-contained). */
  position: 'mobile' | 'desktop';
}

function SavedDraftPill({ slug, relativeTime, position }: SavedDraftPillProps) {
  // Build copy from whatever the localStorage payload carries. Never
  // fabricate slug or time — fall back to a generic line if missing.
  const detailParts: string[] = [];
  if (slug) detailParts.push(`"${slug}"`);
  if (relativeTime) detailParts.push(`you started ${relativeTime}`);
  const detail = detailParts.length
    ? `Sign in to publish ${detailParts.join(' ')}.`
    : 'Sign in to pick up where you left off.';

  return (
    <div
      data-testid="auth-saved-draft"
      data-position={position}
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
        marginTop: position === 'desktop' ? 18 : 0,
        marginBottom: position === 'mobile' ? 18 : 0,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width={18}
        height={18}
        stroke="currentColor"
        fill="none"
        strokeWidth={1.75}
        style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <span>
        <strong style={{ fontWeight: 600 }}>Your draft is saved.</strong> {detail}
      </span>
    </div>
  );
}

function KbdHint({ mac }: { mac: boolean }) {
  return (
    <span
      data-testid="kbd-hint"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: '2px 6px',
        background: 'rgba(255,255,255,0.16)',
        border: '1px solid rgba(255,255,255,0.22)',
        borderRadius: 5,
        color: '#fff',
        fontSize: 10,
        fontWeight: 600,
        fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)',
        lineHeight: 1,
      }}
      aria-hidden="true"
    >
      {mac ? '⌘ ↵' : 'Ctrl ↵'}
    </span>
  );
}

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
