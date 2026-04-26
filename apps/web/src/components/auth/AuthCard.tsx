// v23 PR-F: shared chrome for /login, /signup, /forgot-password,
// /reset-password. Wraps the form column in a centred card with the
// brand lockup at the top, matching wireframes.floom.dev/v23/{login,
// signup,forgot-password,reset-password}.html.
//
// Decision doc: /tmp/wireframe-react/auth-decision.md sections A8 + A9 +
// A19. Lifted into one component so all four routes share the same
// surface (`var(--card)` bg, 1px line border, 18px radius, soft shadow,
// 36px / 32px padding) and the same in-card brand lockup (28px floom
// mark + 18px wordmark, centred).
//
// Why a component instead of a CSS class: each auth page already has a
// unique form body. Sharing the chrome via JSX keeps the wireframe
// parity tight (one place to change padding / shadow / brand) and
// prevents the four pages from drifting.

import type { ReactNode } from 'react';

const SHADOW =
  '0 1px 2px rgba(14,14,12,0.04), 0 8px 24px rgba(14,14,12,0.06), 0 24px 48px rgba(14,14,12,0.04)';

interface AuthCardProps {
  children: ReactNode;
  /** Card max-width. /signup uses 480, others 440. */
  maxWidth?: number;
  /** Wrapper testid for parity bot. */
  dataTestId?: string;
}

export function AuthCard({ children, maxWidth = 440, dataTestId }: AuthCardProps) {
  return (
    <div
      style={{
        maxWidth,
        margin: '48px auto',
        padding: '0 20px',
        boxSizing: 'border-box',
      }}
      className="auth-card-wrap"
    >
      <div
        data-testid={dataTestId ?? 'auth-card'}
        className="auth-card"
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 18,
          padding: '36px 32px',
          boxShadow: SHADOW,
        }}
      >
        <AuthBrandLockup />
        {children}
      </div>
    </div>
  );
}

/**
 * In-card brand lockup: 28px floom mark + 18px "floom" wordmark, centred.
 * Matches wireframe `.lg-brand` block. Single SVG, never replaced with
 * text-in-circle (design rule).
 */
function AuthBrandLockup() {
  return (
    <div
      data-testid="auth-brand-lockup"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginBottom: 24,
        fontSize: 18,
        fontWeight: 600,
        color: 'var(--ink)',
        fontFamily: 'var(--font-display, Inter)',
      }}
    >
      <svg width="28" height="28" viewBox="0 0 100 100" aria-hidden="true">
        <path
          d="M32 26 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
          fill="#047857"
        />
      </svg>
      <span>floom</span>
    </div>
  );
}

/**
 * Shared `<h1>` styles for auth pages. Inter 800 / 28px / -0.02em /
 * centred / line-height 1.1. Matches `.lg-card h1` from wireframe.
 */
export const authH1Style: React.CSSProperties = {
  fontFamily: 'var(--font-display, Inter)',
  fontSize: 28,
  fontWeight: 800,
  letterSpacing: '-0.02em',
  lineHeight: 1.1,
  margin: '0 0 8px',
  color: 'var(--ink)',
  textAlign: 'center',
};

/**
 * Shared subhead `.sub` style. 14px muted centred, 28px bottom margin.
 */
export const authSubStyle: React.CSSProperties = {
  fontSize: 14,
  color: 'var(--muted)',
  margin: '0 0 28px',
  textAlign: 'center',
  lineHeight: 1.55,
};

/**
 * Shared form `<label>` style. Inter 12 / 600 / muted. Per Federico's
 * Flag #4 decision (A12): keep clean Inter 12/600 instead of the mobile
 * mono-uppercase variant the wireframe shows.
 */
export const authLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--muted)',
  marginBottom: 6,
  marginTop: 12,
  fontFamily: 'inherit',
};

/**
 * Shared form input style. font-size 16 (iOS Safari zoom fix per #563),
 * border-radius 9 + padding 11/12 per v23 wireframe.
 */
export const authInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '11px 12px',
  border: '1px solid var(--line)',
  borderRadius: 9,
  background: 'var(--card)',
  fontSize: 16,
  color: 'var(--ink)',
  fontFamily: 'inherit',
  marginBottom: 8,
  boxSizing: 'border-box',
};

/**
 * Primary CTA. Emerald per Federico brief — overrides the wireframe's
 * `btn-ink` on /forgot-password + /reset-password.
 */
export const authPrimaryButtonStyle: React.CSSProperties = {
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
  boxShadow:
    '0 4px 14px rgba(5,150,105,0.28), inset 0 1px 0 rgba(255,255,255,0.18)',
};

/**
 * OAuth tile style. Padding 13/16 + left-aligned content per A15.
 */
export const authOAuthButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  gap: 10,
  width: '100%',
  padding: '13px 16px',
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

/**
 * "OR" divider between OAuth tiles and email/password form.
 * Matches `.lg-divider` from wireframe.
 */
export function AuthOrDivider() {
  return (
    <div
      data-testid="oauth-divider"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        margin: '8px 0 24px',
        color: 'var(--muted)',
        fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)',
        fontSize: 11,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      <span style={{ flex: 1, height: 1, background: 'var(--line)' }} aria-hidden="true" />
      <span>or</span>
      <span style={{ flex: 1, height: 1, background: 'var(--line)' }} aria-hidden="true" />
    </div>
  );
}
