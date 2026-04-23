// Cookie consent banner.
//
// Desktop/tablet: fixed bottom-right pill, ~420px max-width, Accept / Essential
// buttons inline. Behaves like a small corner toast.
//
// Mobile (< 640px, issue #104 from 2026-04-20 audit): the desktop layout
// ate ~30% of a 375x812 iPhone viewport and overlapped the hero CTAs
// ("Publish your app" / "Browse live apps"). On mobile we now render a
// small bottom-left pill (link-style, ~92px wide) that says "Cookies"
// and expands on tap. Nothing below the fold until the user chooses to
// open it, so the hero is never blocked.
//
// Storage + consent lives in `lib/consent.ts` (so the telemetry modules
// can read the choice without importing React). This component calls
// `setConsent` AND inlines `initBrowserSentry` / `initPostHog` (on "Accept
// all") and their close equivalents (on the "all" -> "essential" downgrade)
// so the choice applies in the same session without a reload.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getConsent, setConsent, type Consent } from '../lib/consent';
import { initBrowserSentry, closeBrowserSentry } from '../lib/sentry';
import { initPostHog, closePostHog } from '../lib/posthog';

const MOBILE_BREAKPOINT = 640;

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isMobile;
}

export function CookieBanner() {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (getConsent() === null) setVisible(true);
  }, []);

  if (!visible) return null;

  const accept = (choice: Consent) => {
    const previous = getConsent();
    setConsent(choice);
    // Apply the choice to the telemetry SDKs in the same session.
    if (choice === 'all') {
      // Upgrade: light up Sentry + PostHog now that we have consent.
      initBrowserSentry();
      initPostHog();
    } else if (previous === 'all') {
      // Downgrade: flush + stop both SDKs. Anything already in flight
      // at the network layer can't be recalled — documented on /cookies.
      closeBrowserSentry();
      closePostHog();
    }
    setVisible(false);
  };

  // Mobile collapsed pill — bottom-left, ~92px, doesn't touch the
  // viewport centre where CTAs live. Tap expands to the full banner.
  if (isMobile && !expanded) {
    return (
      <button
        type="button"
        data-testid="cookie-banner-pill"
        onClick={() => setExpanded(true)}
        aria-label="Cookie consent"
        style={{
          position: 'fixed',
          left: 12,
          bottom: 12,
          zIndex: 1000,
          padding: '7px 12px',
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 999,
          boxShadow: '0 6px 20px rgba(14, 14, 12, 0.12)',
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--ink)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        Cookies
      </button>
    );
  }

  // Desktop banner (and expanded mobile banner). On mobile, the
  // expanded variant is centred with a close button so the user can
  // collapse back to the pill.
  const isExpandedMobile = isMobile && expanded;

  // Audit 2026-04-22: the banner used to sit bottom-centre, which the
  // design audit flagged as "covers the fold on every page". Anchored
  // now to bottom-right, capped at 420px, so it reads as a small corner
  // toast. Mobile expanded variant still spans the bottom with its
  // close button.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cookie-banner-title"
      data-testid="cookie-banner"
      style={{
        position: 'fixed',
        right: isExpandedMobile ? 12 : 16,
        left: isExpandedMobile ? 12 : 'auto',
        bottom: 16,
        zIndex: 1000,
        maxWidth: 420,
        padding: '12px 14px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        boxShadow: '0 10px 30px rgba(14, 14, 12, 0.12)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        fontSize: 12.5,
        color: 'var(--ink)',
      }}
    >
      {/* a11y 2026-04-20: labelledby target for the dialog. */}
      <p id="cookie-banner-title" style={{ margin: 0, flex: '1 1 240px', lineHeight: 1.45 }}>
        Floom uses essential cookies for sign-in and preferences. Choose
        "Accept all" to also help us with anonymised analytics and error
        reporting. See the{' '}
        <Link to="/cookies" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
          cookie policy
        </Link>
        .
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
        <button
          type="button"
          onClick={() => accept('essential')}
          style={{
            padding: '7px 12px',
            borderRadius: 8,
            border: '1px solid var(--line)',
            background: 'transparent',
            color: 'var(--ink)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          Essential only
        </button>
        <button
          type="button"
          onClick={() => accept('all')}
          style={{
            padding: '7px 12px',
            borderRadius: 8,
            border: '1px solid var(--accent)',
            background: 'var(--accent)',
            color: '#fff',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          Accept all
        </button>
        {isExpandedMobile && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Close"
            style={{
              padding: '7px 10px',
              borderRadius: 8,
              border: '1px solid var(--line)',
              background: 'transparent',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
