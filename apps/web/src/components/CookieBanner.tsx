// Cookie consent banner.
//
// Desktop/tablet: fixed bottom-centre pill, ~460px max-width, Accept / Essential
// buttons inline. Behaves like a real banner.
//
// Mobile (< 640px, issue #104 from 2026-04-20 audit): the desktop layout
// ate ~30% of a 375x812 iPhone viewport and overlapped the hero CTAs
// ("Publish your app" / "Browse live apps"). On mobile we now render a
// small bottom-left pill (link-style, ~92px wide) that says "Cookies"
// and expands on tap. Nothing below the fold until the user chooses to
// open it, so the hero is never blocked.
// - Persists to localStorage AND a first-party cookie so server-rendered
//   pages can also respect the choice if we add any.
// - Hidden once a choice exists. SSR-safe (guards against undefined window).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

const STORAGE_KEY = 'floom.cookie-consent';
const COOKIE_NAME = 'floom.cookie-consent';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const MOBILE_BREAKPOINT = 640;

type Choice = 'essential' | 'all';

function readChoice(): Choice | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'essential' || v === 'all') return v;
  } catch {
    // localStorage can throw in private mode; fall through to cookie.
  }
  if (typeof document !== 'undefined') {
    const match = document.cookie.match(
      new RegExp('(?:^|; )' + COOKIE_NAME.replace(/\./g, '\\.') + '=([^;]+)'),
    );
    if (match && (match[1] === 'essential' || match[1] === 'all')) {
      return match[1] as Choice;
    }
  }
  return null;
}

function writeChoice(choice: Choice) {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // ignore
  }
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${COOKIE_NAME}=${choice}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // ignore
  }
}

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
    if (readChoice() === null) setVisible(true);
  }, []);

  if (!visible) return null;

  const accept = (choice: Choice) => {
    writeChoice(choice);
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cookie-banner-title"
      data-testid="cookie-banner"
      style={{
        position: 'fixed',
        left: 12,
        right: 12,
        bottom: 12,
        zIndex: 1000,
        maxWidth: 460,
        margin: '0 auto',
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
      {/* a11y 2026-04-20: labelledby target for the dialog. Was
          aria-label="Cookie consent" with no visible title; SRs now
          announce the actual banner text. */}
      <p id="cookie-banner-title" style={{ margin: 0, flex: '1 1 240px', lineHeight: 1.45 }}>
        Floom uses essential cookies for sign-in and preferences. See the{' '}
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
